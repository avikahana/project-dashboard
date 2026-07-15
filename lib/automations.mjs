import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { formatCron } from "./claude-tasks.mjs";
import { AUTOMATIONS_DIR, pathExists, slugify, titleize, uniq } from "./sync-config.mjs";
import { normalizeStatusFields } from "./status-file.mjs";

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

export function parseSimpleToml(raw) {
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

export async function discoverAutomations() {
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

export function withClaudeTasks(projects, tasks) {
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
