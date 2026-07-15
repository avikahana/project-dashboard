import path from "node:path";
import { readJson, writeJsonAtomic } from "./json-files.mjs";
import { CONFIG_PATH, STATUS_FILE, uniq } from "./sync-config.mjs";

export const STATUS_FIELDS = [
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

export function statusFilePathForProject(project) {
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
  ["build", "active"],
  ["building", "active"],
  ["development", "active"],
  ["developing", "active"],
  ["develop", "active"],
  ["implementation", "active"],
  ["implementing", "active"],
  ["implement", "active"],
  ["code", "active"],
  ["coding", "active"],
  ["test", "active"],
  ["testing", "active"],
  ["wip", "active"],
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

export function normalizeStatusFields(project) {
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

// Statuses a tracked card can be moved TO from the row menu. These are the
// canonical group words statusClass() maps to; synonyms in existing files
// (e.g. "wip") get normalized to the target word by a move.
const MOVABLE_STATUSES = new Set([
  "active",
  "maintenance",
  "planning",
  "paused",
  "blocked",
  "completed"
]);

export async function moveProjectStatus(projectId, targetStatus) {
  if (!MOVABLE_STATUSES.has(targetStatus)) {
    const error = new Error(`Unsupported status: ${targetStatus}`);
    error.code = "BAD_STATUS";
    throw error;
  }

  // The id is only matched against curated config entries; the status file
  // path comes from the matched entry, never from the caller.
  const config = await readJson(CONFIG_PATH, null);
  const project = (config?.projects || []).find((entry) => entry.id === projectId);
  if (!project) return null;

  const statusPath = statusFilePathForProject(project);
  const statusData = statusPath ? await readJson(statusPath, null) : null;
  if (!statusData) {
    const error = new Error(`Project has no ${STATUS_FILE} to update: ${projectId}`);
    error.code = "NO_STATUS_FILE";
    throw error;
  }

  statusData.status = targetStatus;
  statusData.updatedAt = new Date().toISOString();
  if (targetStatus === "completed") {
    if (!statusData.completedAt) statusData.completedAt = statusData.updatedAt;
  } else if (statusData.completedAt) {
    // Leaving Completed reopens the project; a stale completion stamp would
    // keep reading as "done" in the status file contract.
    statusData.completedAt = null;
  }

  await writeJsonAtomic(statusPath, `${JSON.stringify(statusData, null, 2)}\n`);
  return { id: projectId, status: targetStatus, statusFile: statusPath };
}
