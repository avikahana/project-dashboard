import assert from "node:assert/strict";
import { test } from "node:test";

// Inline the pure functions under test so the test file stays dependency-free
// (app.js is a browser script, not a module we can import).

function statusClass(value = "") {
  const normalized = value.toLowerCase().replace(/\s+/g, "-");
  if (!normalized) return "";
  if (["complete", "completed", "done", "finished", "shipped", "closed", "resolved"].includes(normalized)) return "completed";
  if (["idea", "backlog", "planned", "planning", "proposed", "proposal", "todo", "not-started"].includes(normalized)) return "planning";
  if (["build", "building", "development", "developing", "develop", "implementation", "implementing", "implement", "code", "coding", "test", "testing", "wip", "active", "activate", "activated", "activation", "ongoing", "in-progress", "working", "started", "open", "current"].includes(normalized)) return "active";
  if (["blocked", "blocker", "stuck", "waiting", "waiting-on", "needs-input"].includes(normalized)) return "blocked";
  if (["pause", "paused", "hold", "on-hold", "deferred", "parked", "shelved", "archived"].includes(normalized)) return "paused";
  if (["live", "production", "prod", "maintain", "maintaining", "maintenance"].includes(normalized)) return "maintenance";
  return "active";
}

const PINNED_GROUP_KEY = "pinned-projects";
const PRIVATE_GROUP_KEY = "private-list";

function groupKey(project, pinnedProjects, hiddenProjects) {
  if (pinnedProjects.has(project.id)) return PINNED_GROUP_KEY;
  if (hiddenProjects.has(project.id)) return PRIVATE_GROUP_KEY;
  if (project.bot) return `bot:${project.bot.name}`;
  return statusClass(project.status || "other") || "other";
}

function projectNeedsReview(project) {
  const missingProgress = project.progress === null || project.progress === undefined;
  if (project.bot && missingProgress) {
    return project.confidence === "low" ||
      Boolean(project.nameCollision) ||
      Boolean(project.health && (project.health.status === "Down" || project.health.error)) ||
      Boolean(project.localPath && !project.localPathFound);
  }

  return missingProgress ||
    project.confidence === "low" ||
    Boolean(project.nameCollision) ||
    Boolean(project.health && (project.health.status === "Down" || project.health.error)) ||
    Boolean(project.localPath && !project.localPathFound);
}

const GROUP_ORDER = [PINNED_GROUP_KEY, "active", "maintenance", "planning", "paused", "blocked", "completed", PRIVATE_GROUP_KEY];

function sortGroups(keys) {
  return [...keys].sort((a, b) => {
    const aBot = a.startsWith("bot:");
    const bBot = b.startsWith("bot:");
    if (aBot && bBot) return a.localeCompare(b);
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    const aOrder = aBot ? 0.5 : ia === -1 ? 999 : ia;
    const bOrder = bBot ? 0.5 : ib === -1 ? 999 : ib;
    return aOrder - bOrder || a.localeCompare(b);
  });
}

// --- Fixtures ---

const BOTS = [
  {
    id: "bot-hal", name: "HAL - Systems monitoring", status: "active",
    source: "bots-board", type: "bot", tags: ["bot-hal"], progress: null,
    bot: { name: "HAL", domain: "Systems monitoring", waitingOn: null }
  },
  {
    id: "bot-hal-2", name: "HAL - Log analysis", status: "blocked",
    source: "bots-board", type: "bot", tags: ["bot-hal"], progress: null,
    bot: { name: "HAL", domain: "Systems monitoring", waitingOn: "Avi" }
  },
  {
    id: "bot-walle", name: "WALL-E - Files and folders structure", status: "active",
    source: "bots-board", type: "bot", tags: ["bot-walle"], progress: null,
    bot: { name: "WALL-E", domain: "File organisation", waitingOn: null }
  },
  {
    id: "bot-optimus", name: "Optimus Prime - Job search", status: "blocked",
    source: "bots-board", type: "bot", tags: ["bot-optimus"], progress: null,
    bot: { name: "Optimus Prime", domain: "Job and freelance search", waitingOn: "Avi" }
  }
];

const LEGACY_PROJECT = {
  id: "my-project", name: "My project", status: "active",
  type: "local", progress: 42
};

// --- Tests ---

test("bot projects group by bot name", () => {
  const pinned = new Set();
  const hidden = new Set();
  const keys = new Set(BOTS.map((p) => groupKey(p, pinned, hidden)));
  assert.deepEqual([...keys].sort(), ["bot:HAL", "bot:Optimus Prime", "bot:WALL-E"]);
});

test("two HAL workstreams land in the same group", () => {
  const pinned = new Set();
  const hidden = new Set();
  const halKeys = BOTS
    .filter((p) => p.bot.name === "HAL")
    .map((p) => groupKey(p, pinned, hidden));
  assert.ok(halKeys.every((k) => k === "bot:HAL"));
});

test("legacy project without bot field falls back to status group", () => {
  const key = groupKey(LEGACY_PROJECT, new Set(), new Set());
  assert.equal(key, "active");
});

test("bot groups sort between pinned and status groups", () => {
  const keys = [PINNED_GROUP_KEY, "bot:WALL-E", "bot:HAL", "active", "blocked"];
  const sorted = sortGroups(keys);
  assert.deepEqual(sorted, [PINNED_GROUP_KEY, "bot:HAL", "bot:WALL-E", "active", "blocked"]);
});

test("bot entry with null progress does NOT need review", () => {
  assert.equal(projectNeedsReview(BOTS[0]), false);
});

test("non-bot entry with null progress DOES need review", () => {
  const project = { ...LEGACY_PROJECT, progress: null };
  assert.equal(projectNeedsReview(project), true);
});

test("bot entry with low confidence still needs review", () => {
  const project = { ...BOTS[0], confidence: "low" };
  assert.equal(projectNeedsReview(project), true);
});

test("non-bot entry with explicit progress does NOT need review", () => {
  assert.equal(projectNeedsReview(LEGACY_PROJECT), false);
});
