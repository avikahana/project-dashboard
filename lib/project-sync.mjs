import { discoverClaudeTasks } from "./claude-tasks.mjs";
import { writeJsonAtomic } from "./json-files.mjs";
import { CONFIG_PATH, STATUS_FILE, readConfigForSync, readSources, uniq } from "./sync-config.mjs";
import { buildDiscoveredProject, buildRetainedProject, discoverProjects } from "./discovery.mjs";
import { discoverAutomations, withClaudeTasks } from "./automations.mjs";

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

// Re-exports keep this module's pre-split public surface stable: server.mjs,
// scripts/sync-projects.mjs, lib/automation-actions.mjs, and any external
// clone importing from project-sync.mjs keep working unchanged.
export { mergeProjectStatusFile, moveProjectStatus } from "./status-file.mjs";
export { AUTOMATIONS_DIR, CONFIG_PATH, DEFAULT_SOURCES, SOURCES_PATH, STATUS_FILE } from "./sync-config.mjs";
export { parseSimpleToml } from "./automations.mjs";
