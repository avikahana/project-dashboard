import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJson } from "./json-files.mjs";
import { IGNORE_NAMES, ROOT_DIR, STATUS_FILE, pathExists, readSources, slugify, titleize, uniq } from "./sync-config.mjs";
import { STATUS_FIELDS, mergeProjectStatusFile, normalizeStatusFields } from "./status-file.mjs";

function shouldIgnoreDirectory(name) {
  const lower = name.toLowerCase();
  return IGNORE_NAMES.has(name) ||
    name.startsWith(".date_backup_") ||
    name.startsWith("_") ||
    lower.includes(".archived-") ||
    lower.includes("-archived-") ||
    lower.includes("archive");
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

export async function discoverProjects() {
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
// frontend's pinned/private preferences stay attached.
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

export function buildDiscoveredProject(discovered, existing, usedIds) {
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

export async function buildRetainedProject(project, usedIds) {
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
