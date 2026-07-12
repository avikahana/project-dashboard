import { execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverClaudeTasks, formatCron } from "./claude-tasks.mjs";
import { readJson, writeJsonAtomic } from "./json-files.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "data", "dashboard.config.json");
const SOURCES_PATH = path.join(ROOT_DIR, "data", "dashboard.sources.json");
const STATUS_FILE = ".project-status.json";
const AUTOMATIONS_DIR = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, "automations")
  : path.join(homedir(), ".codex", "automations");

// Source roots are machine-specific and live in data/dashboard.sources.json
// (gitignored). With no sources configured, sync discovers nothing new but
// still refreshes retained projects and Codex automations.
const DEFAULT_SOURCES = [];

const IGNORE_NAMES = new Set([
  ".cache",
  ".claude",
  ".codex",
  ".git",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "node_modules",
  ".venv",
  "venv"
]);

const STATUS_FIELDS = [
  "name",
  "status",
  "type",
  "projectHome",
  "repoPath",
  "repoUrl",
  "liveUrl",
  "healthCheckUrl",
  "onlineLabel",
  "progress",
  "phase",
  "confidence",
  "nextAction",
  "notes",
  "completedAt",
  "tags",
  "milestones"
];

function statusFilePathForProject(project) {
  return project.statusFile || (project.localPath ? path.join(project.localPath, STATUS_FILE) : null);
}

const STATUS_ALIASES = new Map([
  ["complete", "completed"],
  ["completed", "completed"],
  ["done", "completed"],
  ["finished", "completed"],
  ["shipped", "completed"],
  ["closed", "completed"],
  ["resolved", "completed"],
  ["live", "maintenance"],
  ["production", "maintenance"],
  ["prod", "maintenance"],
  ["maintain", "maintenance"],
  ["maintaining", "maintenance"],
  ["maintenance", "maintenance"],
  ["idea", "planning"],
  ["backlog", "planning"],
  ["planned", "planning"],
  ["planning", "planning"],
  ["proposed", "planning"],
  ["proposal", "planning"],
  ["todo", "planning"],
  ["not-started", "planning"],
  ["build", "building"],
  ["building", "building"],
  ["development", "building"],
  ["developing", "building"],
  ["develop", "building"],
  ["implementation", "building"],
  ["implementing", "building"],
  ["implement", "building"],
  ["code", "building"],
  ["coding", "building"],
  ["test", "building"],
  ["testing", "building"],
  ["wip", "building"],
  ["active", "active"],
  ["activate", "active"],
  ["activated", "active"],
  ["activation", "active"],
  ["ongoing", "active"],
  ["in-progress", "active"],
  ["in progress", "active"],
  ["working", "active"],
  ["started", "active"],
  ["open", "active"],
  ["current", "active"],
  ["blocked", "blocked"],
  ["blocker", "blocked"],
  ["stuck", "blocked"],
  ["waiting", "blocked"],
  ["waiting-on", "blocked"],
  ["needs-input", "blocked"],
  ["pause", "paused"],
  ["paused", "paused"],
  ["hold", "paused"],
  ["on-hold", "paused"],
  ["on hold", "paused"],
  ["deferred", "paused"],
  ["parked", "paused"],
  ["shelved", "paused"],
  ["archived", "paused"]
]);

const PHASE_ALIASES = new Map([
  ["complete", "shipped"],
  ["completed", "shipped"],
  ["done", "shipped"],
  ["finished", "shipped"],
  ["live", "shipped"]
]);

function normalizeStatusFields(project) {
  const normalized = { ...project };
  const rawStatus = String(normalized.status || "").trim();
  const statusKey = rawStatus.toLowerCase().replace(/[_\s]+/g, "-");
  const phaseKey = String(normalized.phase || "").toLowerCase().trim();
  const canonicalStatus = STATUS_ALIASES.get(statusKey);
  if (canonicalStatus) {
    normalized.status = canonicalStatus;
  } else if (rawStatus) {
    normalized.originalStatus = rawStatus;
    normalized.status = "active";
    normalized.tags = uniq([
      ...(Array.isArray(normalized.tags) ? normalized.tags : []),
      "needs-review",
      "status-normalized"
    ]);
  }
  normalized.phase = PHASE_ALIASES.get(phaseKey) || normalized.phase;
  return normalized;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

// A missing config is a fresh start, but a config that exists and fails to
// parse must abort the sync: falling back to an empty project list would
// silently drop every retained project on the next write.
async function readConfigForSync() {
  let raw;
  try {
    raw = await readFile(CONFIG_PATH, "utf8");
  } catch {
    return { schemaVersion: 1, projects: [] };
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Refusing to sync: ${CONFIG_PATH} exists but is not valid JSON (${error.message}). Fix or remove it before syncing.`);
  }
}

function slugify(value) {
  return String(value || "project")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
}

function shouldIgnoreDirectory(name) {
  const lower = name.toLowerCase();
  return IGNORE_NAMES.has(name) ||
    name.startsWith(".date_backup_") ||
    name.startsWith("_") ||
    lower.includes(".archived-") ||
    lower.includes("-archived-") ||
    lower.includes("archive");
}

function titleize(value) {
  return String(value || "Project")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function parseTomlValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"");
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const body = trimmed.slice(1, -1).trim();
    if (!body) return [];
    return body
      .split(/,\s*/)
      .map((item) => parseTomlValue(item))
      .filter((item) => item !== "");
  }
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed;
}

function parseSimpleToml(raw) {
  const data = {};
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!match) return;
    data[match[1]] = parseTomlValue(match[2]);
  });
  return data;
}

function formatTime(hour, minute) {
  const normalizedHour = Number(hour || 0);
  const suffix = normalizedHour >= 12 ? "PM" : "AM";
  const displayHour = normalizedHour % 12 || 12;
  return `${displayHour}:${String(Number(minute || 0)).padStart(2, "0")} ${suffix}`;
}

function formatRRule(rrule) {
  const fields = new Map(
    String(rrule || "")
      .split(";")
      .map((part) => part.split("="))
      .filter((part) => part.length === 2)
  );
  const frequency = fields.get("FREQ");
  const dayNames = {
    MO: "Mondays",
    TU: "Tuesdays",
    WE: "Wednesdays",
    TH: "Thursdays",
    FR: "Fridays",
    SA: "Saturdays",
    SU: "Sundays"
  };
  const day = dayNames[fields.get("BYDAY")] || fields.get("BYDAY");
  const time = formatTime(fields.get("BYHOUR"), fields.get("BYMINUTE"));

  if (frequency === "WEEKLY" && day) return `${day} at ${time}`;
  if (frequency === "DAILY") return `Daily at ${time}`;
  if (frequency === "HOURLY") return "Hourly";
  return rrule || "Schedule not set";
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function execGit(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 2500 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout.trim() || null);
    });
  });
}

async function getPackageName(projectPath) {
  const packageJson = await readJson(path.join(projectPath, "package.json"));
  return packageJson?.name ? titleize(packageJson.name) : null;
}

async function getGitRemote(projectPath) {
  const inside = await execGit(["-C", projectPath, "rev-parse", "--is-inside-work-tree"], ROOT_DIR);
  if (inside !== "true") return null;
  return execGit(["-C", projectPath, "remote", "get-url", "origin"], ROOT_DIR);
}

async function readSources() {
  const configured = await readJson(SOURCES_PATH);
  const sources = Array.isArray(configured?.sources) ? configured.sources : DEFAULT_SOURCES;
  return sources.filter((source) => source.rootPath && source.id);
}

async function discoverProjects() {
  const sources = await readSources();
  const projects = [];
  const skippedRoots = [];

  for (const source of sources) {
    if (!(await pathExists(source.rootPath))) {
      skippedRoots.push(source.rootPath);
      continue;
    }

    const entries = await readdir(source.rootPath, { withFileTypes: true });
    const ignoredPaths = new Set(
      (Array.isArray(source.ignorePaths) ? source.ignorePaths : []).map((ignoredPath) => path.resolve(ignoredPath))
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldIgnoreDirectory(entry.name)) {
        continue;
      }

      const localPath = path.join(source.rootPath, entry.name);
      if (ignoredPaths.has(path.resolve(localPath))) {
        continue;
      }

      const statusPath = path.join(localPath, STATUS_FILE);
      const statusData = await readJson(statusPath, {});
      const repoUrl = statusData.repoUrl || await getGitRemote(localPath);
      const packageName = statusData.name ? null : await getPackageName(localPath);

      projects.push({
        source,
        localPath,
        statusPath,
        statusFound: await pathExists(statusPath),
        statusData,
        packageName,
        repoUrl
      });
    }
  }

  return { projects, skippedRoots };
}

async function discoverAutomations() {
  if (!(await pathExists(AUTOMATIONS_DIR))) {
    return [];
  }

  const entries = await readdir(AUTOMATIONS_DIR, { withFileTypes: true });
  const automations = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const automationPath = path.join(AUTOMATIONS_DIR, entry.name, "automation.toml");
    if (!(await pathExists(automationPath))) continue;

    const data = parseSimpleToml(await readFile(automationPath, "utf8"));
    const id = data.id || entry.name;
    const cwds = Array.isArray(data.cwds) ? data.cwds : [];
    const localPath = cwds[0] || null;
    const status = String(data.status || "").toUpperCase() === "PAUSED" ? "paused" : "active";
    const schedule = formatRRule(data.rrule);

    automations.push(normalizeStatusFields({
      id: `automation-${slugify(id)}`,
      name: data.name || titleize(id),
      status,
      type: "automation",
      localPath,
      repoUrl: null,
      liveUrl: null,
      healthCheckUrl: null,
      progress: null,
      phase: data.kind || "scheduled",
      confidence: "high",
      nextAction: status === "paused" ? "Resume or edit this scheduled task when it should run again." : "Monitor the next scheduled run.",
      notes: data.prompt || "Scheduled task managed by Codex automations.",
      completedAt: null,
      tags: ["scheduled", "automation", data.kind, String(data.status || "").toLowerCase()].filter(Boolean),
      milestones: [
        { name: `Schedule: ${schedule}`, done: true },
        { name: `Status: ${status === "paused" ? "Paused" : "Active"}`, done: true },
        { name: `Execution: ${data.execution_environment || data.destination || "unknown"}`, done: true }
      ],
      source: "codex-automation",
      statusFile: null,
      automationFile: automationPath,
      updatedAt: Number.isFinite(Number(data.updated_at)) && data.updated_at
        ? new Date(Number(data.updated_at)).toISOString().slice(0, 10)
        : null,
      automation: {
        id,
        kind: data.kind || null,
        status: String(data.status || "UNKNOWN").toUpperCase(),
        rrule: data.rrule || null,
        schedule,
        model: data.model || null,
        reasoningEffort: data.reasoning_effort || null,
        executionEnvironment: data.execution_environment || null,
        cwds,
        createdAt: data.created_at || null,
        updatedAt: data.updated_at || null
      }
    }));
  }

  return automations;
}

function claudeTaskAutomationMeta(task) {
  return {
    id: task.id,
    kind: "claude-task",
    status: task.enabled === false ? "PAUSED" : "ACTIVE",
    rrule: null,
    schedule: formatCron(task.cronExpression),
    model: null,
    reasoningEffort: null,
    executionEnvironment: "claude-code",
    cwds: task.cwd ? [task.cwd] : [],
    createdAt: task.createdAt || null,
    updatedAt: task.lastRunAt || null
  };
}

// A Claude scheduled task usually automates an existing project (a task named
// "example-refresh" typically drives the "example" project), so it is attached
// to a project card rather than becoming a second card. Prefix overlap alone
// picks the wrong card when sibling projects share a name stem, so candidates
// are scored: a task whose cwd sits inside the project folder wins outright,
// then an exact slug match, then the longest hyphen-boundary prefix overlap.
// Tasks with no matching card get a standalone card like Codex automations do.
function claudeTaskMatchScore(project, task, taskSlug) {
  if (project.automation) return 0;
  const projectSlug = slugify(path.basename(project.localPath || "") || project.name);
  if (!projectSlug || projectSlug === "project") return 0;

  if (task.cwd && project.localPath) {
    const cwd = path.resolve(task.cwd);
    const localPath = path.resolve(project.localPath);
    if (cwd === localPath || cwd.startsWith(localPath + path.sep)) return 3000;
  }
  if (projectSlug === taskSlug) return 2000;
  if (taskSlug.startsWith(`${projectSlug}-`)) return 1000 + projectSlug.length;
  if (projectSlug.startsWith(`${taskSlug}-`)) return 1000 + taskSlug.length;
  return 0;
}

function withClaudeTasks(projects, tasks) {
  // Attachments are recomputed from the live task registry on every sync, but
  // the tags below were persisted into dashboard.config.json and unioned back
  // by buildDiscoveredProject. Strip the previous sync's artifacts (identified
  // by the claude-task marker) so a deleted task does not leave its card
  // stuck on the Scheduled tab; live tasks re-add them just below.
  for (const project of projects) {
    if (!Array.isArray(project.tags) || !project.tags.includes("claude-task")) continue;
    project.tags = project.tags.filter((tag) => tag !== "claude-task" && tag !== "scheduled" && tag !== "automation");
    if (project.automation?.kind === "claude-task") delete project.automation;
  }

  for (const task of tasks) {
    const taskSlug = slugify(task.id);
    const automation = claudeTaskAutomationMeta(task);
    const paused = automation.status === "PAUSED";

    let match = null;
    let matchScore = 0;
    for (const project of projects) {
      const score = claudeTaskMatchScore(project, task, taskSlug);
      if (score > matchScore) {
        match = project;
        matchScore = score;
      }
    }

    if (match) {
      match.automation = automation;
      match.tags = uniq([...(Array.isArray(match.tags) ? match.tags : []), "scheduled", "automation", "claude-task"]);
      continue;
    }

    projects.push(normalizeStatusFields({
      id: `claude-task-${taskSlug}`,
      name: titleize(task.id),
      status: paused ? "paused" : "active",
      type: "automation",
      localPath: task.cwd || null,
      repoUrl: null,
      liveUrl: null,
      healthCheckUrl: null,
      progress: null,
      phase: "scheduled",
      confidence: "high",
      nextAction: paused ? "Resume or edit this scheduled task when it should run again." : "Monitor the next scheduled run.",
      notes: "Scheduled task managed by Claude Code.",
      completedAt: null,
      tags: ["scheduled", "automation", "claude-task"],
      milestones: [
        { name: `Schedule: ${automation.schedule}`, done: true },
        { name: `Status: ${paused ? "Paused" : "Active"}`, done: true },
        { name: "Execution: claude-code", done: true }
      ],
      source: "claude-task",
      statusFile: null,
      automationFile: task.registryPath,
      updatedAt: task.lastRunAt ? String(task.lastRunAt).slice(0, 10) : null,
      automation
    }));
  }
  return projects;
}

function stableSuffix(value) {
  const text = String(value || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

// On id collision, derive the suffix from a stable key (the project's path)
// rather than a processing-order counter, so ids survive re-syncs and the
// frontend's pinned/private localStorage keys stay attached.
function ensureId(baseId, usedIds, stableKey) {
  let id = baseId;
  if (usedIds.has(id) && stableKey) {
    id = `${baseId}-${stableSuffix(stableKey)}`;
  }
  let counter = 2;
  while (usedIds.has(id)) {
    id = `${baseId}-${counter}`;
    counter += 1;
  }
  usedIds.add(id);
  return id;
}

function buildDiscoveredProject(discovered, existing, usedIds) {
  const folderName = path.basename(discovered.localPath);
  const baseId = existing?.id || slugify(`${discovered.source.id}-${folderName}`);
  const status = discovered.statusData || {};
  const tags = uniq([
    ...(existing?.tags || []),
    discovered.source.type,
    discovered.source.label.toLowerCase().replace(/\s+/g, "-"),
    discovered.statusFound ? "status-file" : "needs-status-file"
  ]);

  const merged = {
    id: ensureId(baseId, usedIds, discovered.localPath),
    name: existing?.name || status.name || discovered.packageName || titleize(folderName),
    status: existing?.status || "active",
    type: existing?.type || discovered.source.type,
    localPath: discovered.localPath,
    repoUrl: existing?.repoUrl || discovered.repoUrl || null,
    liveUrl: existing?.liveUrl || null,
    healthCheckUrl: existing?.healthCheckUrl || null,
    onlineLabel: existing?.onlineLabel || null,
    progress: existing?.progress ?? null,
    phase: existing?.phase || "planning",
    confidence: existing?.confidence || (discovered.statusFound ? "medium" : "low"),
    nextAction: existing?.nextAction || (discovered.statusFound ? "Review current project status" : "Add .project-status.json"),
    notes: existing?.notes || `Auto-discovered from ${discovered.source.label}.`,
    completedAt: existing?.completedAt || null,
    tags,
    milestones: existing?.milestones || [
      { name: "Project discovered", done: true },
      { name: "Status file present", done: discovered.statusFound }
    ],
    source: discovered.source.id,
    statusFile: discovered.statusFound ? discovered.statusPath : null,
    discoveredAt: existing?.discoveredAt || new Date().toISOString(),
    updatedAt: status.updatedAt || existing?.updatedAt || null
  };

  for (const field of STATUS_FIELDS) {
    if (!Object.hasOwn(status, field)) continue;
    // Status files win, except an explicit null never erases a curated value
    // (auto-generated status files ship null liveUrl/healthCheckUrl fields).
    if (status[field] === null && merged[field] != null) continue;
    merged[field] = status[field];
  }

  merged.tags = uniq([
    ...(Array.isArray(merged.tags) ? merged.tags : []),
    discovered.source.type,
    discovered.statusFound ? "status-file" : "needs-status-file"
  ]);

  if (!Array.isArray(merged.milestones)) {
    merged.milestones = [];
  }

  return normalizeStatusFields(merged);
}

async function buildRetainedProject(project, usedIds) {
  const retained = {
    ...project,
    id: ensureId(
      project.id || slugify(project.name || project.localPath),
      usedIds,
      project.statusFile || project.localPath || project.name
    )
  };

  return mergeProjectStatusFile(retained);
}

export async function mergeProjectStatusFile(project) {
  const statusPath = statusFilePathForProject(project);
  if (!statusPath) {
    return normalizeStatusFields(project);
  }

  const statusData = await readJson(statusPath, null);
  if (!statusData) {
    return normalizeStatusFields(project);
  }

  const retained = { ...project };
  for (const field of STATUS_FIELDS) {
    if (!Object.hasOwn(statusData, field)) continue;
    // Status files win, except an explicit null never erases a curated value.
    if (statusData[field] === null && retained[field] != null) continue;
    retained[field] = statusData[field];
  }

  retained.statusFile = statusPath;
  retained.updatedAt = statusData.updatedAt || retained.updatedAt || null;
  retained.tags = uniq([
    ...(Array.isArray(retained.tags) ? retained.tags : []),
    "status-file"
  ]);

  return normalizeStatusFields(retained);
}

function sortProjects(projects) {
  return projects.sort((a, b) => {
    const sourceOrder = { codex: 1, claude: 2, local: 3, online: 4, repo: 5, automation: 6 };
    const aOrder = sourceOrder[a.type] || 9;
    const bOrder = sourceOrder[b.type] || 9;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function canonicalProjectKey(project) {
  if (project.automation?.id || project.automationFile) {
    return `automation:${project.automation?.id || project.automationFile}`;
  }
  return project.statusFile || project.localPath || null;
}

function mergeDuplicateProjects(projects) {
  const merged = [];
  const byKey = new Map();

  for (const project of projects) {
    const key = canonicalProjectKey(project);
    if (!key || !byKey.has(key)) {
      merged.push(project);
      if (key) byKey.set(key, project);
      continue;
    }

    const existing = byKey.get(key);
    existing.tags = uniq([
      ...(Array.isArray(existing.tags) ? existing.tags : []),
      ...(Array.isArray(project.tags) ? project.tags : [])
    ]);
    existing.repoUrl = existing.repoUrl || project.repoUrl || null;
    existing.liveUrl = existing.liveUrl || project.liveUrl || null;
    existing.healthCheckUrl = existing.healthCheckUrl || project.healthCheckUrl || null;
    existing.onlineLabel = existing.onlineLabel || project.onlineLabel || null;
    existing.milestones = Array.isArray(existing.milestones) && existing.milestones.length > 0
      ? existing.milestones
      : project.milestones;
  }

  return merged;
}

// Serialize syncs within the process: an overlapping read-modify-write of
// dashboard.config.json could otherwise lose or corrupt data.
let activeSync = Promise.resolve();

export function syncProjects(options = {}) {
  const run = activeSync.then(() => runSyncProjects(options), () => runSyncProjects(options));
  activeSync = run.then(() => undefined, () => undefined);
  return run;
}

async function runSyncProjects({ write = true } = {}) {
  const currentConfig = await readConfigForSync();
  const existingProjects = Array.isArray(currentConfig.projects) ? currentConfig.projects : [];
  const byPath = new Map(existingProjects.filter((project) => project.localPath).map((project) => [project.localPath, project]));
  const { projects: discovered, skippedRoots } = await discoverProjects();
  const automations = await discoverAutomations();
  const claudeTasks = await discoverClaudeTasks();
  const discoveredPaths = new Set(discovered.map((project) => project.localPath));
  const sourceIds = new Set((await readSources()).map((source) => source.id));
  const usedIds = new Set();

  const synced = discovered.map((project) => buildDiscoveredProject(project, byPath.get(project.localPath), usedIds));
  const retainedCandidates = existingProjects
    .filter((project) => {
      if (project.id === "scheduled" || project.source === "codex-automation" || project.source === "claude-task" || project.automationFile) return false;
      if (project.localPath && discoveredPaths.has(project.localPath)) return false;
      if (project.source && sourceIds.has(project.source)) return false;
      return true;
    })
  const retained = await Promise.all(retainedCandidates.map((project) => buildRetainedProject(project, usedIds)));

  const nextConfig = {
    ...currentConfig,
    schemaVersion: currentConfig.schemaVersion || 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    generatedFrom: [
      "project folders",
      "git metadata",
      STATUS_FILE,
      "existing dashboard index"
    ],
    projects: sortProjects(mergeDuplicateProjects(withClaudeTasks([...retained, ...synced, ...automations], claudeTasks)))
  };

  if (write) {
    await writeJsonAtomic(CONFIG_PATH, `${JSON.stringify(nextConfig, null, 2)}\n`);
  }

  return {
    generatedAt: new Date().toISOString(),
    written: write,
    configPath: CONFIG_PATH,
    discovered: discovered.length,
    automations: automations.length,
    retained: retained.length,
    total: nextConfig.projects.length,
    statusFiles: nextConfig.projects.filter((project) => project.statusFile).length,
    skippedRoots,
    projects: nextConfig.projects
  };
}

export { AUTOMATIONS_DIR, CONFIG_PATH, DEFAULT_SOURCES, SOURCES_PATH, STATUS_FILE, parseSimpleToml };
