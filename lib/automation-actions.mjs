import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTOMATIONS_DIR, parseSimpleToml } from "./project-sync.mjs";
import { findClaudeTask, readClaudeTaskPrompt, setClaudeTaskEnabled } from "./claude-tasks.mjs";
import { readJson } from "./json-files.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(ROOT_DIR, "data", "automation-runs");
const STATUS_BACKUP_PATH = path.join(ROOT_DIR, "data", "automation-status-backup.json");
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const LOG_TAIL_CHARS = 4000;
// The Codex CLI ships inside the ChatGPT desktop app and is usually not on
// PATH, so fall back to the app bundle when no standalone install exists.
const CODEX_APP_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";
// launchd starts this server with a minimal PATH, so the Claude Code CLI's
// default install location is the fallback when PATH resolution fails.
const CLAUDE_FALLBACK_BINARY = path.join(homedir(), ".local", "bin", "claude");

// In-flight dashboard-triggered runs, keyed by automation id. Guards the
// one-concurrent-run-per-automation rule for this server process.
const activeRuns = new Map();

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

// Automations are always resolved by scanning the directory and matching the
// requested id against what is on disk; the client-supplied id never becomes
// part of a filesystem path.
export async function findAutomation(requestedId) {
  if (!requestedId || !(await pathExists(AUTOMATIONS_DIR))) return null;

  const entries = await readdir(AUTOMATIONS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const automationFile = path.join(AUTOMATIONS_DIR, entry.name, "automation.toml");
    if (!(await pathExists(automationFile))) continue;

    const data = parseSimpleToml(await readFile(automationFile, "utf8"));
    const id = data.id || entry.name;
    if (id === requestedId || entry.name === requestedId) {
      return { id, file: automationFile, data };
    }
  }

  return null;
}

// Flips only the status line, byte-for-byte otherwise: the TOML is owned by
// the Codex app, so nothing else in it may be rewritten. The literal that was
// active before a pause is remembered in a sidecar so resume restores exactly
// what Codex wrote (observed literal: "ACTIVE").
export async function setAutomationStatus(requestedId, action, runner) {
  const automation = runner === "claude" ? null : await findAutomation(requestedId);
  if (!automation) {
    if (runner === "codex") return null;
    // Not a Codex automation: try Claude scheduled tasks, where pause/resume
    // is the registry's `enabled` flag rather than a TOML literal.
    return setClaudeTaskEnabled(requestedId, action === "resume");
  }

  const raw = await readFile(automation.file, "utf8");
  const statusLine = raw.match(/^status\s*=\s*"([^"]*)"[ \t]*$/m);
  if (!statusLine) {
    throw new Error(`No status field found in ${automation.file}`);
  }

  const current = statusLine[1];
  const paused = current.toUpperCase() === "PAUSED";

  if (action === "pause" && paused) {
    return { id: automation.id, status: current, changed: false };
  }
  if (action === "resume" && !paused) {
    return { id: automation.id, status: current, changed: false };
  }

  let nextLiteral;
  if (action === "pause") {
    const backups = await readJson(STATUS_BACKUP_PATH, {});
    backups[automation.id] = current;
    await mkdir(path.dirname(STATUS_BACKUP_PATH), { recursive: true });
    await writeFile(STATUS_BACKUP_PATH, `${JSON.stringify(backups, null, 2)}\n`);
    nextLiteral = "PAUSED";
  } else {
    const backups = await readJson(STATUS_BACKUP_PATH, {});
    nextLiteral = backups[automation.id] || "ACTIVE";
  }

  await writeFile(automation.file, raw.replace(statusLine[0], `status = "${nextLiteral}"`));
  return { id: automation.id, status: nextLiteral, changed: true };
}

async function resolveBinary(name, fallback) {
  for (const dir of (process.env.PATH || "").split(":").filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (await pathExists(candidate)) return candidate;
  }
  if (fallback && (await pathExists(fallback))) return fallback;
  return null;
}

function runError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function writeRunMeta(metaPath, meta) {
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`).catch(() => {});
}

// Reproduces the automation's work with its own prompt and cwd: Codex
// automations run via `codex exec`, Claude scheduled tasks via `claude -p`.
// Neither app exposes an external trigger for the real schedule record, so
// these runs will not appear in the apps' own histories.
export async function runAutomation(requestedId, runner) {
  const automation = runner === "claude" ? null : await findAutomation(requestedId);
  if (automation) {
    return runCodexAutomation(automation);
  }
  if (runner === "codex") return null;
  const task = await findClaudeTask(requestedId);
  if (task) {
    return runClaudeTask(task);
  }
  return null;
}

async function runCodexAutomation(automation) {
  const prompt = automation.data.prompt;
  if (!prompt) {
    throw runError(`Automation "${automation.id}" has no prompt to run`, "NO_PROMPT");
  }

  const codexBinary = await resolveBinary("codex", CODEX_APP_BINARY);
  if (!codexBinary) {
    throw runError("Codex CLI not found on PATH or in the ChatGPT app bundle", "NO_CODEX");
  }

  const cwds = Array.isArray(automation.data.cwds) ? automation.data.cwds : [];
  const cwd = cwds[0] && (await pathExists(cwds[0])) ? cwds[0] : homedir();

  const args = ["exec", "--cd", cwd];
  if (automation.data.model) args.push("-m", String(automation.data.model));
  if (automation.data.reasoning_effort) {
    args.push("-c", `model_reasoning_effort="${automation.data.reasoning_effort}"`);
  }
  args.push(prompt);

  return launchDetachedRun(automation.id, codexBinary, args, cwd);
}

// Local-files-plus-read-only-web allowlist. Headless `claude -p` auto-denies
// any tool not granted here, so a dashboard-triggered run can read, write
// locally, fetch pages, and invoke skills, but can never use Bash or MCP
// connectors regardless of what the task prompt asks for.
const CLAUDE_TASK_ALLOWED_TOOLS = "Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Skill";

async function runClaudeTask(task) {
  const prompt = await readClaudeTaskPrompt(task);
  if (!prompt) {
    throw runError(`Scheduled task "${task.id}" has no prompt to run`, "NO_PROMPT");
  }

  const claudeBinary = await resolveBinary("claude", CLAUDE_FALLBACK_BINARY);
  if (!claudeBinary) {
    throw runError("Claude Code CLI not found on PATH or in ~/.local/bin", "NO_CLAUDE");
  }

  const cwd = task.cwd && (await pathExists(task.cwd)) ? task.cwd : homedir();
  // --allowedTools is variadic, so it must come after the positional prompt
  // or it swallows the prompt as another tool name.
  const args = ["-p", prompt, "--allowedTools", CLAUDE_TASK_ALLOWED_TOOLS];

  return launchDetachedRun(task.id, claudeBinary, args, cwd);
}

async function launchDetachedRun(id, binary, args, cwd) {
  if (activeRuns.has(id)) {
    throw runError(`Automation "${id}" is already running`, "RUN_ACTIVE");
  }

  const startedAt = new Date().toISOString();
  const runDir = path.join(RUNS_DIR, id);
  const logPath = path.join(runDir, `${startedAt.replace(/[:.]/g, "-")}.log`);
  const metaPath = logPath.replace(/\.log$/, ".json");

  // Reserve the id before the first await: two overlapping requests would
  // otherwise both pass the has() check above and spawn two agents.
  const meta = { id, startedAt, status: "running", pid: null, logPath, binary };
  activeRuns.set(id, meta);

  let child;
  try {
    await mkdir(runDir, { recursive: true });
    const logFd = openSync(logPath, "a");
    try {
      // Detached so a dashboard-server restart does not kill an in-flight run.
      child = spawn(binary, args, { cwd, detached: true, stdio: ["ignore", logFd, logFd] });
    } finally {
      closeSync(logFd);
    }
  } catch (error) {
    activeRuns.delete(id);
    throw error;
  }

  meta.pid = child.pid;
  await writeRunMeta(metaPath, meta);

  const timeout = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Process group already gone.
    }
  }, RUN_TIMEOUT_MS);
  timeout.unref();

  child.on("error", (error) => {
    clearTimeout(timeout);
    activeRuns.delete(id);
    writeRunMeta(metaPath, { ...meta, status: "failed", finishedAt: new Date().toISOString(), error: error.message });
  });

  child.on("exit", (exitCode, signal) => {
    clearTimeout(timeout);
    activeRuns.delete(id);
    writeRunMeta(metaPath, {
      ...meta,
      status: exitCode === 0 ? "succeeded" : "failed",
      finishedAt: new Date().toISOString(),
      exitCode,
      signal: signal || null
    });
  });

  child.unref();
  return { id, startedAt, logPath };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function getLastRun(requestedId, runner) {
  const automation = runner === "claude" ? null : await findAutomation(requestedId);
  const id = automation
    ? automation.id
    : runner === "codex" ? null : (await findClaudeTask(requestedId))?.id;
  if (!id) return null;

  const active = activeRuns.get(id);
  let run = active ? { ...active } : null;

  if (!run) {
    const runDir = path.join(RUNS_DIR, id);
    if (await pathExists(runDir)) {
      const metaFiles = (await readdir(runDir)).filter((name) => name.endsWith(".json")).sort();
      const newest = metaFiles.at(-1);
      if (newest) {
        const metaPath = path.join(runDir, newest);
        run = await readJson(metaPath);
        // Runs are detached, so a server restart loses the exit listener. If
        // the recorded pid is gone, the run finished untracked; correct the
        // record instead of reporting "running" forever.
        if (run?.status === "running" && !(run.pid && pidAlive(run.pid))) {
          run = { ...run, status: "finished-untracked", finishedAt: null, exitCode: null };
          await writeRunMeta(metaPath, run);
        }
      }
    }
  }

  if (run?.logPath && (await pathExists(run.logPath))) {
    const log = await readFile(run.logPath, "utf8").catch(() => "");
    run.logTail = log.slice(-LOG_TAIL_CHARS);
  }

  return { id, run };
}
