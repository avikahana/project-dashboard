import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./json-files.mjs";

// Claude Code scheduled tasks live in two places: the desktop app registers
// each task (id, cron, enabled, lastRunAt) in a per-session scheduled-tasks.json
// under the sessions dir, while the prompt itself is the SKILL.md the registry's
// filePath points at. Both files are owned by the Claude app, so writes here
// must be surgical: only the `enabled` flag is ever changed.
const SESSIONS_DIR = process.env.CLAUDE_SESSIONS_DIR
  || path.join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");

async function listRegistryFiles() {
  const files = [];
  let outerEntries;
  try {
    outerEntries = await readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const outer of outerEntries) {
    if (!outer.isDirectory()) continue;
    const outerPath = path.join(SESSIONS_DIR, outer.name);
    let innerEntries;
    try {
      innerEntries = await readdir(outerPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const inner of innerEntries) {
      if (!inner.isDirectory()) continue;
      files.push(path.join(outerPath, inner.name, "scheduled-tasks.json"));
    }
  }

  return files;
}

// A freshly re-registered task has a createdAt but no lastRunAt yet, so
// recency has to consider both: otherwise the live registration would lose
// the dedup below to a dead session that happened to run once in the past.
// Timestamps are compared as strings (ISO order is lexicographic).
function taskRecency(task) {
  const lastRun = String(task.lastRunAt || "");
  const created = String(task.createdAt || "");
  return lastRun > created ? lastRun : created;
}

// The frontend polls last-run per scheduled card, and each lookup would
// otherwise re-walk the entire sessions directory; cache the walk briefly.
const DISCOVER_CACHE_TTL_MS = 15000;
let discoverCache = { at: 0, tasks: null };

function invalidateClaudeTaskCache() {
  discoverCache = { at: 0, tasks: null };
}

export async function discoverClaudeTasks() {
  if (discoverCache.tasks && Date.now() - discoverCache.at < DISCOVER_CACHE_TTL_MS) {
    return discoverCache.tasks;
  }

  const tasks = new Map();

  for (const registryPath of await listRegistryFiles()) {
    const parsed = await readJson(registryPath);
    if (!parsed) continue;
    for (const task of parsed.scheduledTasks || []) {
      if (!task?.id) continue;
      // The same task id can appear in more than one session registry; the
      // most recently registered or run one is the live registration.
      const existing = tasks.get(task.id);
      if (existing && taskRecency(existing) >= taskRecency(task)) continue;
      tasks.set(task.id, { ...task, registryPath });
    }
  }

  const result = [...tasks.values()];
  discoverCache = { at: Date.now(), tasks: result };
  return result;
}

export async function findClaudeTask(requestedId) {
  if (!requestedId) return null;
  return (await discoverClaudeTasks()).find((task) => task.id === requestedId) || null;
}

// Pause/resume for a Claude task is the registry's boolean `enabled` flag.
// The rest of the registry entry is rewritten byte-for-byte via parse/stringify
// in the same 2-space format the app itself writes. The registry belongs to
// the Claude app, so the write is atomic (temp + rename): a crash mid-write
// must never leave the app a truncated task registry.
export async function setClaudeTaskEnabled(requestedId, enabled) {
  const task = await findClaudeTask(requestedId);
  if (!task) return null;

  const raw = await readJson(task.registryPath);
  const entry = (raw?.scheduledTasks || []).find((candidate) => candidate.id === task.id);
  if (!entry) return null;

  const changed = Boolean(entry.enabled) !== enabled;
  if (changed) {
    entry.enabled = enabled;
    await writeJsonAtomic(task.registryPath, JSON.stringify(raw, null, 2));
    invalidateClaudeTaskCache();
  }

  return { id: task.id, status: enabled ? "ACTIVE" : "PAUSED", changed };
}

// The prompt the app runs on schedule: the SKILL.md body without its
// frontmatter block.
export async function readClaudeTaskPrompt(task) {
  const raw = await readFile(task.filePath, "utf8").catch(() => "");
  const withoutFrontmatter = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
  return withoutFrontmatter.trim() || null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function formatCron(expression) {
  const parts = String(expression || "").trim().split(/\s+/);
  if (parts.length !== 5) return expression || "Unknown schedule";

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== "*") return expression;

  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (dayOfMonth === "*" && dayOfWeek === "*") return `Daily at ${time}`;
  if (dayOfMonth === "*" && /^\d+$/.test(dayOfWeek)) {
    return `Every ${WEEKDAYS[Number(dayOfWeek) % 7]} at ${time}`;
  }
  if (dayOfWeek === "*" && /^\d+$/.test(dayOfMonth)) {
    return `Monthly on day ${dayOfMonth} at ${time}`;
  }
  return expression;
}
