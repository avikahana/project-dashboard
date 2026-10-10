const HIDDEN_PROJECTS_KEY = "dashboard-hidden-projects";
const PINNED_PROJECTS_KEY = "dashboard-pinned-projects";
const CHECKED_NEXT_STEPS_KEY = "dashboard-checked-next-steps";
const AUTO_REFRESH_MS = 30000;
const PRS_REFRESH_MS = 60000;
const FOCUS_REFRESH_STALE_MS = 5000;
const NEXT_PROJECT_PREVIEW_LIMIT = 6;

function readStoredSet(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

const state = {
  projects: [],
  view: localStorage.getItem("dashboard-view") || "projects",
  statusFilter: "all",
  sortMode: "progress",
  query: "",
  showAllCompleted: false,
  showAllNextProjects: false,
  generatedAt: null,
  nextProjects: [],
  theme: localStorage.getItem("dashboard-theme") || "dark",
  collapsedGroups: new Set(),
  nextStepsCollapsed: false,
  checklist: null,
  checklistCollapsed: false,
  waitingPrs: null,
  expandedChecklistItems: new Set(),
  expandedProjects: new Set(),
  expandedNextSteps: new Set(),
  expandedCardText: new Set(),
  expandedNextProjects: new Set(),
  expandedOnlineProjects: new Set(),
  hiddenProjects: readStoredSet(HIDDEN_PROJECTS_KEY),
  pinnedProjects: readStoredSet(PINNED_PROJECTS_KEY),
  checkedNextSteps: readStoredSet(CHECKED_NEXT_STEPS_KEY),
  activeMenuProjectId: null,
  moveMenuProjectId: null,
  healthById: new Map(),
  toastTimer: null,
  loadingProjects: null,
  projectLoadVersion: 0,
  lastProjectLoadStartedAt: 0
};

const elements = {
  list: document.querySelector("#project-list"),
  onlineSection: document.querySelector("#online-section"),
  completedPanel: document.querySelector("#completed-panel"),
  completedList: document.querySelector("#completed-list"),
  nextProjects: document.querySelector("#next-projects"),
  nextProjectList: document.querySelector("#next-project-list"),
  toggleNextProjects: document.querySelector("#toggle-next-projects"),
  template: document.querySelector("#project-card-template"),
  search: document.querySelector("#search"),
  controlBand: document.querySelector(".control-band"),
  projectsHead: document.querySelector("#projects-head"),
  checklistsView: document.querySelector("#checklists-view"),
  prsView: document.querySelector("#prs-view"),
  prsCount: document.querySelector("#prs-count"),
  viewTabs: [...document.querySelectorAll(".view-tab")],
  statusTabs: [...document.querySelectorAll(".status-tab")],
  sortTabs: [...document.querySelectorAll(".sort-tab")],
  refreshProjects: document.querySelector("#refresh-projects"),
  refreshHealth: document.querySelector("#refresh-health"),
  restartServer: document.querySelector("#restart-server"),
  themeToggle: document.querySelector("#theme-toggle"),
  themeToggleLabel: document.querySelector("#theme-toggle-label"),
  toggleCompleted: document.querySelector("#toggle-completed"),
  toggleGroups: document.querySelector("#toggle-groups"),
  backToTop: document.querySelector("#back-to-top"),
  toast: document.querySelector("#toast"),
  lastUpdated: document.querySelector("#last-updated"),
  viewEyebrow: document.querySelector("#view-eyebrow"),
  viewTitle: document.querySelector("#view-title"),
  metrics: {
    showing: document.querySelector("#metric-showing"),
    planning: document.querySelector("#metric-planning"),
    completed: document.querySelector("#metric-completed"),
    online: document.querySelector("#metric-online"),
    review: document.querySelector("#metric-review")
  }
};

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  elements.themeToggle.setAttribute("aria-pressed", String(state.theme === "dark"));
  elements.themeToggleLabel.textContent = state.theme === "dark" ? "Dark" : "Light";
}

const statusLabels = {
  all: ["All", "Every tracked project"],
  ongoing: ["Ongoing", "Current work"],
  completed: ["Completed", "Done and discoverable"],
  review: ["Needs review", "Unknowns to clean up"],
  duplicates: ["Duplicates", "Name or source collisions"]
};

// Order and display labels for the collapsible status groups.
const PRIVATE_GROUP_KEY = "private-list";
const PINNED_GROUP_KEY = "pinned-projects";
const GROUP_ORDER = [PINNED_GROUP_KEY, "active", "maintenance", "planning", "paused", "blocked", "completed", PRIVATE_GROUP_KEY];

function isOnlineProject(project) {
  return Boolean(project.liveUrl || project.healthCheckUrl || project.type === "online");
}

// Online membership is additive: online projects still land in their status
// group here, and additionally get a card in the separate Online section.
// Bot entries are grouped by bot name; everything else falls back to status.
function groupKey(project) {
  if (state.pinnedProjects.has(projectId(project))) return PINNED_GROUP_KEY;
  if (state.hiddenProjects.has(projectId(project))) return PRIVATE_GROUP_KEY;
  if (project.bot) return `bot:${project.bot.name}`;
  return statusClass(project.status || "other") || "other";
}

function onlineDisplayName(project) {
  return project.onlineLabel || project.name;
}

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

function projectUpdatedTime(project) {
  const value = project.updatedAt || project.completedAt || project.git?.lastCommit?.date || "";
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function compareProjectsWithinGroup(a, b) {
  if (state.sortMode === "updated") {
    return projectUpdatedTime(b) - projectUpdatedTime(a) ||
      String(a.name || "").localeCompare(String(b.name || ""));
  }

  if (state.sortMode === "alpha") {
    return String(a.name || "").localeCompare(String(b.name || ""));
  }

  return (b.progress ?? -1) - (a.progress ?? -1) ||
    projectUpdatedTime(b) - projectUpdatedTime(a) ||
    String(a.name || "").localeCompare(String(b.name || ""));
}

function projectId(project) {
  return project.id || project.statusFile || project.localPath || project.name;
}

// The Private list is server-persisted (data/dashboard.prefs.json) so hiding
// a project holds on every origin the dashboard is reached from; localStorage
// is per-origin and only read once here as a legacy fallback until the first
// /api/projects response migrates it up to the server.
async function setProjectPrivacy(id, hidden) {
  if (hidden) {
    state.hiddenProjects.add(id);
  } else {
    state.hiddenProjects.delete(id);
  }
  render();
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/${hidden ? "hide" : "unhide"}`, { method: "POST" });
    if (!response.ok) throw new Error(`Privacy update failed: ${response.status}`);
    const payload = await response.json();
    if (Array.isArray(payload.hiddenProjects)) {
      state.hiddenProjects = new Set(payload.hiddenProjects);
      render();
    }
  } catch (error) {
    if (hidden) {
      state.hiddenProjects.delete(id);
    } else {
      state.hiddenProjects.add(id);
    }
    render();
    showToast(error.message);
  }
}

// One-time migration: entries this browser still holds in localStorage are
// pushed up to the server, then the legacy key is dropped. Unioning the
// per-origin lists is the point: localhost and the tunnel hostname finally
// agree on what is private.
function applyServerHiddenList(serverList) {
  if (!Array.isArray(serverList)) return;
  const merged = new Set(serverList);
  const legacy = readStoredSet(HIDDEN_PROJECTS_KEY);
  if (legacy.size) {
    localStorage.removeItem(HIDDEN_PROJECTS_KEY);
    [...legacy].filter((id) => !merged.has(id)).forEach((id) => {
      merged.add(id);
      fetch(`/api/projects/${encodeURIComponent(id)}/hide`, { method: "POST" }).catch(() => {});
    });
  }
  state.hiddenProjects = merged;
}

function savePinnedProjects() {
  localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify([...state.pinnedProjects]));
}

function saveCheckedNextSteps() {
  localStorage.setItem(CHECKED_NEXT_STEPS_KEY, JSON.stringify([...state.checkedNextSteps]));
}

function updateBackToTop() {
  elements.backToTop.hidden = window.scrollY < 520;
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 1800);
}

function compactDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

// PR cards show freshness as an age ("3h ago"): what matters there is how
// long a PR has been waiting, not the wall-clock moment it last moved.
// Anything older than a week falls back to the absolute compactDate.
function relativeTime(value) {
  const time = new Date(value).getTime();
  if (!value || Number.isNaN(time)) return "Unknown";
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return compactDate(value);
}

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

function isOngoing(project) {
  return statusClass(project.status) !== "completed";
}

function matchesStatus(project) {
  if (state.statusFilter === "all") return true;
  if (state.statusFilter === "ongoing") return isOngoing(project);
  if (state.statusFilter === "completed") return statusClass(project.status) === "completed";
  if (state.statusFilter === "review") return projectNeedsReview(project);
  if (state.statusFilter === "duplicates") return Boolean(project.nameCollision || project.sourceCollision);
  return true;
}

function matchesSearch(project) {
  if (!state.query) return true;
  const haystack = [
    project.name,
    project.status,
    project.type,
    project.localPath,
    project.repoUrl,
    project.liveUrl,
    project.notes,
    project.nextAction,
    projectRole(project),
    ...(project.tags || [])
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(state.query.toLowerCase());
}

function labelize(value) {
  return String(value || "unknown")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function sourceLabel(project) {
  return labelize(project.source || project.type || "unknown");
}

function projectRole(project) {
  const tags = new Set((project.tags || []).map((tag) => String(tag).toLowerCase()));
  const name = String(project.name || "").toLowerCase();

  if (tags.has("brain") || name.includes("brain")) return "Private Brain";
  if (tags.has("repo") || project.type === "repo" || project.repoUrl) return "Product repo";
  if (project.type === "online" || project.liveUrl || project.healthCheckUrl) return "Live website";
  if (tags.has("knowledge") || tags.has("source")) return "Knowledge workspace";
  if (tags.has("resume") || tags.has("career")) return "Career workspace";
  if (tags.has("home-assistant") || tags.has("integration")) return "Integration workspace";
  if (tags.has("legal")) return "Legal workspace";
  if (project.confidence === "low" || tags.has("needs-review")) return "Needs triage";
  return "Project workspace";
}

function pathShortName(project) {
  const segments = String(project.localPath || "")
    .split("/")
    .filter(Boolean);
  return segments.at(-1) || sourceLabel(project);
}

function normalizedProjectName(project) {
  return String(project.name || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function annotateProjectRelationships(projects) {
  const byName = new Map();
  const bySource = new Map();

  projects.forEach((project) => {
    const key = normalizedProjectName(project);
    if (!key) return;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(project);

    const sourceKey = project.statusFile || project.localPath;
    if (!sourceKey) return;
    if (!bySource.has(sourceKey)) bySource.set(sourceKey, []);
    bySource.get(sourceKey).push(project);
  });

  return projects.map((project) => {
    const matches = byName.get(normalizedProjectName(project)) || [];
    const distinctPaths = new Set(matches.map((match) => match.localPath).filter(Boolean));
    const sourceMatches = bySource.get(project.statusFile || project.localPath) || [];
    const sourceCollision = sourceMatches.length > 1
      ? {
          count: sourceMatches.length,
          ids: sourceMatches.map((match) => projectId(match))
        }
      : null;

    if (matches.length < 2 || distinctPaths.size < 2) {
      return { ...project, nameCollision: null, sourceCollision };
    }

    return {
      ...project,
      sourceCollision,
      nameCollision: {
        count: matches.length,
        homes: matches
          .filter((match) => projectId(match) !== projectId(project))
          .map((match) => `${sourceLabel(match)}: ${match.localPath || match.name}`)
      }
    };
  });
}

function createBadge(text, variant = "", title = "") {
  const badge = document.createElement("span");
  badge.className = `badge ${variant}`.trim();
  badge.textContent = text;
  if (title) badge.title = title;
  return badge;
}

function appendEvidence(list, label, value, title = "") {
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = value || "Unknown";
  if (title) {
    dt.title = title;
    dd.title = title;
  }
  list.append(dt, dd);
}

function createLink(label, href) {
  const link = document.createElement("a");
  link.className = "link-pill";
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  return link;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the focused textarea fallback below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-999px";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function createCopyButton(label, value) {
  const button = document.createElement("button");
  button.className = "copy-button";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    await copyText(value);
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = label;
    }, 1200);
  });
  return button;
}

function buildNextProjectContext(item) {
  return [
    formatLine("Project idea", item.title),
    formatLine("Category", item.category),
    formatLine("Status", item.status),
    formatLine("Summary", item.summary),
    formatLine("Why it matters", item.why),
    formatLine("Next action", item.nextAction),
    formatLine("Source thread", item.sourceThreadId)
  ].join("\n");
}

function formatLine(label, value) {
  return value === null || value === undefined || value === "" ? `${label}: Not set` : `${label}: ${value}`;
}

function buildAgentContext(project) {
  const milestones = (project.milestones || [])
    .map((milestone) => `- ${milestone.done ? "[done]" : "[open]"} ${milestone.name ?? milestone.title ?? ""}`)
    .join("\n") || "- Not set";
  const tags = (project.tags || []).join(", ") || "Not set";
  const git = project.git?.available
    ? [
        formatLine("Branch", project.git.branch),
        formatLine("Dirty", project.git.dirty ? `${project.git.changedFiles} changed files` : "clean"),
        formatLine("Last commit", project.git.lastCommit ? `${project.git.lastCommit.hash} - ${project.git.lastCommit.subject}` : null),
        formatLine("Remote", project.git.remoteUrl)
      ].join("\n")
    : formatLine("Git", project.git?.reason || "Not checked");

  return [
    "I want to ask about this dashboard project. Use this context, and inspect the local path or status file when you need more evidence.",
    "",
    formatLine("Project", project.name),
    formatLine("ID", projectId(project)),
    formatLine("Type", project.type),
    formatLine("Source", project.source),
    formatLine("Status", project.status),
    formatLine("Phase", project.phase),
    formatLine("Progress", Number.isFinite(project.progress) ? `${project.progress}%` : "Unknown"),
    formatLine("Confidence", project.confidence),
    formatLine("Project home", project.projectHome || project.localPath),
    formatLine("Repo path", project.repoPath),
    formatLine("Status file", project.statusFile),
    formatLine("Repo URL", project.repoUrl || project.git?.remoteUrl),
    formatLine("Live URL", project.liveUrl),
    formatLine("Health check URL", project.healthCheckUrl),
    formatLine("Next action", project.nextAction),
    formatLine("Notes", project.notes),
    formatLine("Tags", tags),
    "",
    "Milestones:",
    milestones,
    "",
    "Git:",
    git
  ].join("\n");
}

async function shareProjectContext(project) {
  const text = buildAgentContext(project);
  const title = `${project.name} project context`;

  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      showToast("Project context shared");
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }

  await copyText(text);
  showToast("Agent context copied");
}

// Move targets are the canonical group words statusClass() maps to. Pinned
// (browser-local) and Private (server-persisted prefs) are toggles, not
// statuses, and Scheduled is automation-only, so none of them appear here.
const MOVE_TARGETS = [
  ["active", "Active"],
  ["maintenance", "Maintenance"],
  ["planning", "Planning"],
  ["paused", "Paused"],
  ["blocked", "Blocked"],
  ["completed", "Completed"]
];

async function moveProjectToGroup(project, status, label) {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId(project))}/move/${status}`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Move failed: ${response.status}`);
    showToast(`${project.name || "Project"} moved to ${label}`);
    await loadProjects({ quiet: true, force: true });
  } catch (error) {
    showToast(error.message);
  }
}

// Long free-text card fields (next action, notes) are clamped by CSS with a
// Show more toggle. The threshold is character-based so the toggle is
// deterministic without measuring the rendered DOM.
const LONG_CARD_TEXT = 240;

function setExpandableCardText(node, text, key) {
  node.textContent = text;
  if (text.length <= LONG_CARD_TEXT) return;
  const expanded = state.expandedCardText.has(key);
  node.classList.toggle("is-clamped", !expanded);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "text-toggle";
  toggle.textContent = expanded ? "Show less" : "Show more";
  toggle.addEventListener("click", () => {
    if (expanded) state.expandedCardText.delete(key);
    else state.expandedCardText.add(key);
    render();
  });
  node.after(toggle);
}

function renderProject(project) {
  const node = elements.template.content.firstElementChild.cloneNode(true);
  const id = projectId(project);
  const progress = Number.isFinite(project.progress) ? project.progress : null;
  const healthStatus = project.health?.status || (project.liveUrl || project.healthCheckUrl ? "Unknown" : null);
  const repoUrl = project.repoUrl || project.git?.remoteUrl;
  const progressValue = node.querySelector(".progress-value");

  node.dataset.status = statusClass(project.status);
  node.querySelector(".project-type").textContent = `Type: ${labelize(project.type || "project")} / Status: ${labelize(project.status)}`;
  node.querySelector("h3").textContent = project.name;

  const badges = node.querySelector(".badge-row");
  badges.append(createBadge(`Status: ${labelize(project.status)}`, statusClass(project.status), "Current workflow state for this project"));
  badges.append(createBadge(project.confidence ? `Confidence: ${labelize(project.confidence)}` : "Confidence: Unknown", project.confidence === "low" ? "review" : "", "How sure the dashboard seed data is"));
  badges.append(createBadge(projectRole(project), "", "What role this tracked project plays"));
  badges.append(createBadge(sourceLabel(project), "", "Dashboard source root for this card"));
  if (healthStatus) badges.append(createBadge(`Health: ${healthStatus}`, statusClass(healthStatus), "Live website or bot health, separate from progress"));
  if (project.nameCollision) badges.append(createBadge("Same name", "review", `Also tracked as ${project.nameCollision.homes.join("; ")}`));
  if (project.sourceCollision) badges.append(createBadge("Same source", "review", "Multiple dashboard records point at the same status file or local path"));
  if (projectNeedsReview(project)) badges.append(createBadge("Review needed", "review", "Some project fields are missing, uncertain, or need confirmation"));

  progressValue.textContent = progress === null ? "Progress unknown" : `${progress}%`;
  progressValue.classList.toggle("is-unknown", progress === null);
  node.querySelector(".phase").textContent = project.phase || "Unknown phase";
  node.querySelector(".progress-track span").style.setProperty("--progress-width", progress === null ? "0%" : `${Math.max(0, Math.min(100, progress))}%`);
  setExpandableCardText(node.querySelector(".next-action"), project.nextAction ? `Next: ${project.nextAction}` : "Next: Not set", `${id}::next`);
  setExpandableCardText(node.querySelector(".notes"), project.notes || "", `${id}::notes`);

  // Open milestones live in the main pile; completed ones move to their own
  // collapsed section below so they stop drowning out what is still to do.
  const milestones = node.querySelector(".milestones");
  const projectMilestones = project.milestones || [];
  const openMilestones = projectMilestones.filter((milestone) => !milestone.done);
  const doneMilestones = projectMilestones.filter((milestone) => milestone.done);
  openMilestones.forEach((milestone) => {
    const item = document.createElement("span");
    item.className = "milestone";
    item.textContent = `Open: ${milestone.name ?? milestone.title ?? ""}`;
    milestones.append(item);
  });
  if (doneMilestones.length > 0) {
    const doneExpanded = state.expandedCardText.has(`${id}::milestones`);
    const doneWrap = document.createElement("div");
    doneWrap.className = "milestones-done";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "done-toggle";
    toggle.setAttribute("aria-expanded", String(doneExpanded));
    toggle.textContent = `${doneExpanded ? "▾" : "›"} Completed (${doneMilestones.length})`;
    toggle.addEventListener("click", () => {
      if (doneExpanded) state.expandedCardText.delete(`${id}::milestones`);
      else state.expandedCardText.add(`${id}::milestones`);
      render();
    });
    doneWrap.append(toggle);

    if (doneExpanded) {
      const doneList = document.createElement("div");
      doneList.className = "milestones";
      doneMilestones.forEach((milestone) => {
        const item = document.createElement("span");
        item.className = "milestone done";
        item.textContent = milestone.name ?? milestone.title ?? "";
        doneList.append(item);
      });
      doneWrap.append(doneList);
    }

    milestones.after(doneWrap);
  }

  const evidence = node.querySelector(".evidence");
  appendEvidence(evidence, "Role", projectRole(project), "How this card should be interpreted");
  if (project.bot) {
    appendEvidence(evidence, "Bot", project.bot.name, "Which AI bot owns this workstream");
    if (project.bot.domain) appendEvidence(evidence, "Domain", project.bot.domain, "The bot's area of responsibility");
    if (project.bot.waitingOn) appendEvidence(evidence, "Waiting on", project.bot.waitingOn, "Who or what this bot is waiting on");
  }
  appendEvidence(evidence, "Source", sourceLabel(project), "Dashboard source root that discovered this project");
  appendEvidence(evidence, "Folder", project.localPathFound ? "Found" : project.localPath ? "Missing" : "Not set", "Whether the configured localPath exists on this Mac");
  appendEvidence(evidence, "Project home", project.projectHome || project.localPath || "Not set", "Private project context folder");
  appendEvidence(evidence, "Repo path", project.repoPath || "Not set", "Clean code repository folder");
  appendEvidence(evidence, "Git state", project.git?.available ? `${project.git.branch}, ${project.git.dirty ? "uncommitted changes" : "clean"}` : project.git?.reason, "Current branch and whether Git sees local changes");
  appendEvidence(evidence, "Last commit", project.git?.lastCommit ? `${compactDate(project.git.lastCommit.date)} / ${project.git.lastCommit.hash}` : "Unknown", "Most recent commit in the local repo");
  appendEvidence(evidence, "Changed files", project.git?.available ? `${project.git.changedFiles} files` : "Unknown", "Number of changed or untracked files Git sees");
  appendEvidence(evidence, "Live health", project.health ? `${project.health.status}${project.health.statusCode ? ` / ${project.health.statusCode}` : ""}` : healthStatus || "Not online", "Result of the latest configured live URL check");
  appendEvidence(evidence, "Last checked", project.health?.checkedAt ? compactDate(project.health.checkedAt) : "Not checked", "When live health was last checked from this dashboard");
  appendEvidence(evidence, "Completed", project.completedAt || "Not completed", "Completion date from the dashboard config");

  const links = node.querySelector(".links");
  if (project.projectHome || project.localPath) links.append(createCopyButton("Copy home", project.projectHome || project.localPath));
  if (project.repoPath) links.append(createCopyButton("Copy repo", project.repoPath));
  if (repoUrl) links.append(createLink("Repo", repoUrl));
  if (project.liveUrl) links.append(createLink("Live", project.liveUrl));

  return node;
}

function renderCompactRow(project) {
  const id = projectId(project);
  const expanded = state.expandedProjects.has(id);
  const hidden = state.hiddenProjects.has(id);
  const pinned = state.pinnedProjects.has(id);
  const progress = Number.isFinite(project.progress) ? project.progress : null;
  const review = projectNeedsReview(project);
  const maskPrivateTitle = hidden && !expanded;
  const displayName = maskPrivateTitle ? "Private project" : project.name;

  const row = document.createElement("div");
  row.className = "compact-row";
  row.dataset.status = statusClass(project.status);
  row.dataset.projectId = id;
  if (expanded) row.classList.add("is-open");
  if (hidden) row.classList.add("is-private");
  if (pinned) row.classList.add("is-pinned");
  if (state.activeMenuProjectId === id) row.classList.add("is-menu-open");

  const rowHead = document.createElement("div");
  rowHead.className = "row-head";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "row-trigger";
  trigger.setAttribute("aria-expanded", String(expanded));

  const chevron = document.createElement("span");
  chevron.className = "row-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "›";

  const dot = document.createElement("span");
  dot.className = "row-dot";
  dot.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "row-name";
  if (maskPrivateTitle) name.classList.add("is-masked");
  name.textContent = displayName;

  // Flags sit next to the title inside the flexible zone, so the right-hand
  // columns (path, meta, actions) line up across every row.
  const title = document.createElement("span");
  title.className = "row-title";
  title.append(name);
  if (project.nameCollision) {
    const duplicate = document.createElement("span");
    duplicate.className = "row-flag";
    duplicate.title = `Same project name is tracked in ${project.nameCollision.count} places`;
    duplicate.textContent = "same name";
    title.append(duplicate);
  }
  if (project.sourceCollision) {
    const duplicate = document.createElement("span");
    duplicate.className = "row-flag";
    duplicate.title = `Same source is tracked by ${project.sourceCollision.count} records`;
    duplicate.textContent = "same source";
    title.append(duplicate);
  }
  if (review) {
    const flag = document.createElement("span");
    flag.className = "row-flag";
    flag.title = "Needs review";
    flag.textContent = "review";
    title.append(flag);
  }
  const home = document.createElement("span");
  home.className = "row-home";
  if (hidden && !expanded) {
    home.textContent = "Private";
  } else if (project.bot) {
    const parts = [labelize(project.status)];
    if (project.bot.waitingOn) parts[0] = `Blocked · ${project.bot.waitingOn}`;
    if (project.bot.domain) parts.push(project.bot.domain);
    home.textContent = parts.join(" / ");
  } else {
    home.textContent = `${sourceLabel(project)} / ${projectRole(project)} / ${pathShortName(project)}`;
  }

  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = progress === null ? "—" : `${progress}%`;
  if (progress === null) meta.classList.add("is-unknown");

  trigger.append(chevron, dot, title, home, meta);

  trigger.addEventListener("click", () => {
    if (state.expandedProjects.has(id)) state.expandedProjects.delete(id);
    else state.expandedProjects.add(id);
    render();
  });

  const menuWrap = document.createElement("div");
  menuWrap.className = "row-menu-wrap";

  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "row-menu-button";
  menuButton.textContent = "...";
  menuButton.title = "Project actions";
  menuButton.setAttribute("aria-label", `Project actions for ${displayName}`);
  menuButton.setAttribute("aria-haspopup", "menu");
  menuButton.setAttribute("aria-expanded", String(state.activeMenuProjectId === id));
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    state.activeMenuProjectId = state.activeMenuProjectId === id ? null : id;
    state.moveMenuProjectId = null;
    render();
  });

  menuWrap.append(menuButton);

  if (state.activeMenuProjectId === id) {
    const menu = document.createElement("div");
    menu.className = "row-menu";
    menu.setAttribute("role", "menu");
    menu.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    const shareButton = document.createElement("button");
    shareButton.type = "button";
    shareButton.setAttribute("role", "menuitem");
    shareButton.textContent = "Share with agent";
    shareButton.addEventListener("click", async () => {
      state.activeMenuProjectId = null;
      render();
      await shareProjectContext(project);
    });

    const pinButton = document.createElement("button");
    pinButton.type = "button";
    pinButton.setAttribute("role", "menuitem");
    pinButton.textContent = pinned ? "Unpin project" : "Pin project";
    pinButton.addEventListener("click", () => {
      if (pinned) {
        state.pinnedProjects.delete(id);
      } else {
        state.pinnedProjects.add(id);
        if (state.hiddenProjects.has(id)) setProjectPrivacy(id, false);
      }
      state.activeMenuProjectId = null;
      savePinnedProjects();
      render();
    });

    menu.append(shareButton, pinButton);

    const moveOpen = state.moveMenuProjectId === id;
    const moveButton = document.createElement("button");
    moveButton.type = "button";
    moveButton.setAttribute("role", "menuitem");
    moveButton.setAttribute("aria-haspopup", "menu");
    moveButton.setAttribute("aria-expanded", String(moveOpen));
    moveButton.textContent = moveOpen ? "Move to ▴" : "Move to ▾";
    moveButton.addEventListener("click", () => {
      state.moveMenuProjectId = moveOpen ? null : id;
      render();
    });
    menu.append(moveButton);

    if (moveOpen) {
      const subItem = (label, onPick) => {
        const item = document.createElement("button");
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.className = "row-menu-subitem";
        item.textContent = label;
        item.addEventListener("click", () => {
          state.activeMenuProjectId = null;
          state.moveMenuProjectId = null;
          onPick();
        });
        return item;
      };

      if (hidden) {
        menu.append(subItem("Show in groups", () => {
          setProjectPrivacy(id, false);
        }));
      }

      // Group moves rewrite the project's own .project-status.json, so they
      // need one. Picking a group for a private card also brings it back.
      if (project.statusFile) {
        MOVE_TARGETS.filter(([value]) => value !== statusClass(project.status)).forEach(([value, label]) => {
          menu.append(subItem(label, () => {
            if (hidden) {
              setProjectPrivacy(id, false);
            } else {
              render();
            }
            moveProjectToGroup(project, value, label);
          }));
        });
      }

      // Private is visibility, not a status: it changes no status files, only
      // the server-side prefs list, and stays available on every card.
      if (!hidden) {
        menu.append(subItem("Private", () => {
          state.pinnedProjects.delete(id);
          savePinnedProjects();
          state.expandedProjects.delete(id);
          setProjectPrivacy(id, true);
        }));
      }
    }

    menuWrap.append(menu);
  }

  rowHead.append(trigger, menuWrap);
  row.append(rowHead);

  if (expanded) {
    const detail = document.createElement("div");
    detail.className = "row-detail";
    detail.append(renderProject(project));
    row.append(detail);
  }

  return row;
}

function renderGroupedList(container, projects, { withHeads = true } = {}) {
  const groups = new Map();
  projects.forEach((project) => {
    const key = groupKey(project);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(project);
  });

  const fragments = sortGroups(groups.keys()).map((key) => {
    const items = groups.get(key).sort(compareProjectsWithinGroup);
    const collapsed = withHeads && state.collapsedGroups.has(key);

    const group = document.createElement("section");
    group.className = "project-group";
    group.dataset.status = key;

    if (withHeads) {
      const head = document.createElement("button");
      head.type = "button";
      head.className = "group-head";
      head.setAttribute("aria-expanded", String(!collapsed));

      const gchevron = document.createElement("span");
      gchevron.className = "group-chevron";
      gchevron.setAttribute("aria-hidden", "true");
      gchevron.textContent = "▾";

      const gname = document.createElement("span");
      gname.className = "group-name";
      gname.textContent = key.startsWith("bot:") ? key.slice(4) : labelize(key);

      const gcount = document.createElement("span");
      gcount.className = "group-count";
      gcount.textContent = String(items.length);

      head.append(gchevron, gname, gcount);
      head.addEventListener("click", () => {
        if (state.collapsedGroups.has(key)) state.collapsedGroups.delete(key);
        else state.collapsedGroups.add(key);
        render();
      });

      group.append(head);
    }

    if (!collapsed) {
      const body = document.createElement("div");
      body.className = "group-body";
      body.append(...items.map(renderCompactRow));
      group.append(body);
    }

    return group;
  });

  container.replaceChildren(...fragments);
}

function onlineTone(health) {
  if (!health || !health.status || health.status === "Unknown") return "unknown";
  if (health.status === "Live") return "up";
  if (health.status === "Redirecting" || health.status === "Auth required") return "reachable";
  return "down";
}

function onlineStatusText(health) {
  if (!health || !health.status) return "Not checked yet";
  const parts = [health.status];
  if (health.statusCode) parts.push(String(health.statusCode));
  if (Number.isFinite(health.responseTimeMs)) parts.push(`${health.responseTimeMs} ms`);
  if (health.checkedAt) parts.push(`checked ${compactDate(health.checkedAt)}`);
  return parts.join(" / ");
}

function focusProjectCard(project) {
  const id = projectId(project);
  state.view = "projects";
  localStorage.setItem("dashboard-view", state.view);
  if (!getProjectViewProjects().some((candidate) => projectId(candidate) === id)) {
    state.statusFilter = "all";
  }
  state.collapsedGroups.delete(groupKey(project));
  state.expandedProjects.add(id);
  render();
  document.querySelector(`.compact-row[data-project-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderOnlineCard(project) {
  const hidden = state.hiddenProjects.has(projectId(project));
  const health = project.health || null;

  const card = document.createElement("article");
  card.className = "online-card";
  card.dataset.tone = onlineTone(health);

  const head = document.createElement("div");
  head.className = "online-head";

  const dot = document.createElement("span");
  dot.className = "online-dot";
  dot.setAttribute("aria-hidden", "true");

  const name = document.createElement("h3");
  name.textContent = onlineDisplayName(project);

  head.append(dot, name);

  const host = document.createElement("p");
  host.className = "online-host";
  try {
    host.textContent = new URL(project.liveUrl || project.healthCheckUrl).hostname;
  } catch {
    host.textContent = project.liveUrl || project.healthCheckUrl || "";
  }

  const status = document.createElement("p");
  status.className = "online-status";
  status.textContent = onlineStatusText(health);

  const links = document.createElement("div");
  links.className = "online-links";
  if (project.liveUrl) links.append(createLink("Open", project.liveUrl));

  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "link-pill";
  jump.textContent = "Project card";
  if (hidden) {
    // Private projects keep their online card, but it stays status-only.
    jump.disabled = true;
    jump.title = "Private project";
  } else {
    jump.addEventListener("click", () => focusProjectCard(project));
  }
  links.append(jump);

  card.append(head, host, status, links);
  return card;
}

// The strip has no header and no collapse control: the online cards are part
// of the page base and stay visible at all times.
function renderOnlineSection(onlineProjects) {
  const hasProjects = onlineProjects.length > 0;
  elements.onlineSection.hidden = !hasProjects;
  if (!hasProjects) {
    elements.onlineSection.replaceChildren();
    return;
  }

  const body = document.createElement("div");
  body.className = "online-list";
  const sorted = [...onlineProjects].sort((a, b) => onlineDisplayName(a).localeCompare(onlineDisplayName(b)));
  body.append(...sorted.map(renderOnlineCard));

  elements.onlineSection.replaceChildren(body);
}

// Online tab body: one detail card per online project with the full health
// result plus the related project status, next to the always-visible strip.
function renderOnlineDetailRow(project) {
  const id = projectId(project);
  const hidden = state.hiddenProjects.has(id);
  const health = project.health || null;
  const progress = Number.isFinite(project.progress) ? project.progress : null;
  const repoUrl = project.repoUrl || project.git?.remoteUrl;
  const expanded = state.expandedOnlineProjects.has(id);

  const row = document.createElement("div");
  row.className = "compact-row";
  row.dataset.tone = onlineTone(health);
  if (expanded) row.classList.add("is-open");

  const rowHead = document.createElement("div");
  rowHead.className = "row-head";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "row-trigger";
  trigger.setAttribute("aria-expanded", String(expanded));

  const chevron = document.createElement("span");
  chevron.className = "row-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "›";

  const dot = document.createElement("span");
  dot.className = "row-dot";
  dot.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "row-name";
  name.textContent = onlineDisplayName(project);

  const title = document.createElement("span");
  title.className = "row-title";
  title.append(name);

  const home = document.createElement("span");
  home.className = "row-home";
  try {
    home.textContent = new URL(project.liveUrl || project.healthCheckUrl).hostname;
  } catch {
    home.textContent = project.liveUrl || project.healthCheckUrl || "";
  }

  trigger.append(chevron, dot, title, home);
  trigger.addEventListener("click", () => {
    if (state.expandedOnlineProjects.has(id)) state.expandedOnlineProjects.delete(id);
    else state.expandedOnlineProjects.add(id);
    render();
  });

  const actions = document.createElement("div");
  actions.className = "row-actions";
  if (project.liveUrl) actions.append(createLink("Open", project.liveUrl));

  rowHead.append(trigger, actions);
  row.append(rowHead);

  if (expanded) {
    const detail = document.createElement("div");
    detail.className = "row-detail online-detail";

    const details = document.createElement("dl");
    details.className = "evidence online-detail-facts";
    appendEvidence(details, "Live status", onlineStatusText(health), "Result of the latest configured live URL check");
    appendEvidence(details, "Status code", health?.statusCode ? String(health.statusCode) : "Unknown", "HTTP status code from the latest check");
    appendEvidence(details, "Response time", Number.isFinite(health?.responseTimeMs) ? `${health.responseTimeMs} ms` : "Unknown", "How long the latest check took");
    appendEvidence(details, "Last checked", health?.checkedAt ? compactDate(health.checkedAt) : "Not checked", "When live health was last checked from this dashboard");
    appendEvidence(details, "Live URL", project.liveUrl || "Not set", "Public address this check hits");
    if (project.healthCheckUrl && project.healthCheckUrl !== project.liveUrl) {
      appendEvidence(details, "Health check URL", project.healthCheckUrl, "Dedicated health endpoint used for the check");
    }
    if (!hidden) {
      // Private projects keep their detail status-only, same as the strip.
      appendEvidence(details, "Project status", labelize(project.status), "Current workflow state for this project");
      appendEvidence(details, "Phase", project.phase || "Unknown phase", "Current project phase from the dashboard config");
      appendEvidence(details, "Progress", progress === null ? "Unknown" : `${progress}%`, "Hand-set progress, separate from live health");
      appendEvidence(details, "Next action", project.nextAction || "Not set", "Concrete next step for this project");
      appendEvidence(details, "Git state", project.git?.available ? `${project.git.branch}, ${project.git.dirty ? "uncommitted changes" : "clean"}` : project.git?.reason, "Current branch and whether Git sees local changes");
      appendEvidence(details, "Last commit", project.git?.lastCommit ? `${compactDate(project.git.lastCommit.date)} / ${project.git.lastCommit.hash}` : "Unknown", "Most recent commit in the local repo");
    }

    const links = document.createElement("div");
    links.className = "online-links";
    if (!hidden && repoUrl) links.append(createLink("Repo", repoUrl));

    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "link-pill";
    jump.textContent = "Project card";
    if (hidden) {
      jump.disabled = true;
      jump.title = "Private project";
    } else {
      jump.addEventListener("click", () => focusProjectCard(project));
    }
    links.append(jump);

    detail.append(details, links);
    row.append(detail);
  }

  return row;
}

function renderOnlineDetailList(onlineProjects) {
  const sorted = [...onlineProjects].sort((a, b) => onlineDisplayName(a).localeCompare(onlineDisplayName(b)));
  const list = document.createElement("div");
  list.className = "online-detail-list";
  list.append(...sorted.map(renderOnlineDetailRow));
  elements.list.replaceChildren(list);
}

function groupKeysOf(projects) {
  const keys = [];
  const seen = new Set();
  projects.forEach((project) => {
    const key = groupKey(project);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  });
  return keys;
}

function projectIdsOf(projects) {
  return projects.map(projectId);
}

function allVisibleExpanded(projects) {
  const keys = groupKeysOf(projects);
  const projectIds = projectIdsOf(projects);
  return keys.length > 0 &&
    keys.every((key) => !state.collapsedGroups.has(key)) &&
    projectIds.every((id) => state.expandedProjects.has(id));
}

function updateGroupToggle(visible) {
  const keys = groupKeysOf(visible);
  elements.toggleGroups.disabled = keys.length === 0;
  elements.toggleGroups.textContent = allVisibleExpanded(visible) ? "Collapse all" : "Expand all";
}

function getVisibleProjects() {
  return state.projects.filter((project) => matchesStatus(project) && matchesSearch(project));
}

function getProjectViewProjects() {
  return getVisibleProjects();
}

function renderMetrics() {
  const all = state.projects;
  const ongoing = all.filter(isOngoing).length;
  const planning = all.filter((project) => statusClass(project.status) === "planning").length;
  const completed = all.filter((project) => statusClass(project.status) === "completed").length;
  const onlineProjects = all.filter(isOnlineProject);
  const review = all.filter(projectNeedsReview).length;

  elements.metrics.showing.textContent = ongoing;
  elements.metrics.planning.textContent = planning;
  elements.metrics.completed.textContent = completed;
  elements.metrics.online.textContent = onlineProjects.length;
  elements.metrics.review.textContent = review;
}

function renderCompletedPanel() {
  const completed = state.projects
    .filter((project) => statusClass(project.status) === "completed")
    .sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")));
  const visible = state.showAllCompleted ? completed : completed.slice(0, 3);

  elements.completedPanel.hidden = state.view !== "projects" || state.statusFilter !== "ongoing";
  elements.toggleCompleted.textContent = state.showAllCompleted ? "Show last completed" : "Show all completed";
  elements.completedList.replaceChildren(...visible.map(renderProject));

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No completed projects are configured yet.";
    elements.completedList.replaceChildren(empty);
  }
}

function nextProjectKey(item, index) {
  return item.id || item.title || `idea-${index}`;
}

// Suggestions share the tracked-list row look: collapsed row with chevron,
// dot, title and meta, Copy idea on the right, details in the expanded body.
async function postNextProjectAction(item, action) {
  const response = await fetch(`/api/next-projects/${encodeURIComponent(item.id)}/${action}`, { method: "POST" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${action} failed: ${response.status}`);
  return payload;
}

function createNextProjectActionButton(item, action, label, confirmText, doneToast) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    if (!window.confirm(confirmText)) return;
    button.disabled = true;
    try {
      await postNextProjectAction(item, action);
      showToast(doneToast);
      await loadNextProjects();
      // Start runs a sync server-side; refresh so the new card shows up.
      if (action === "start") await loadProjects({ quiet: true, force: true });
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  });
  return button;
}

function renderNextProject(item, index) {
  const key = nextProjectKey(item, index);
  const expanded = state.expandedNextProjects.has(key);

  const row = document.createElement("div");
  row.className = "compact-row";
  row.dataset.status = "planning";
  if (expanded) row.classList.add("is-open");

  const rowHead = document.createElement("div");
  rowHead.className = "row-head";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "row-trigger";
  trigger.setAttribute("aria-expanded", String(expanded));

  const chevron = document.createElement("span");
  chevron.className = "row-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "›";

  const dot = document.createElement("span");
  dot.className = "row-dot";
  dot.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "row-name";
  name.textContent = item.title || "Untitled idea";

  const title = document.createElement("span");
  title.className = "row-title";
  title.append(name);

  const home = document.createElement("span");
  home.className = "row-home";
  home.textContent = [item.category, item.status].filter(Boolean).join(" / ") || "Idea";

  trigger.append(chevron, dot, title, home);
  trigger.addEventListener("click", () => {
    if (state.expandedNextProjects.has(key)) state.expandedNextProjects.delete(key);
    else state.expandedNextProjects.add(key);
    renderNextProjects();
  });

  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.append(
    createNextProjectActionButton(
      item,
      "start",
      "Start",
      `Start "${item.title}"? This creates a project home folder with a planning status file and adds it to the Tracked board.`,
      "Project started"
    ),
    createCopyButton("Copy idea", buildNextProjectContext(item)),
    createNextProjectActionButton(
      item,
      "dismiss",
      "Dismiss",
      `Dismiss "${item.title}"? It disappears from this list; restoring means editing data/next-projects.json.`,
      "Suggestion dismissed"
    )
  );

  rowHead.append(trigger, actions);
  row.append(rowHead);

  if (expanded) {
    const detail = document.createElement("div");
    detail.className = "row-detail next-project-detail";

    const summary = document.createElement("p");
    summary.className = "next-project-summary";
    summary.textContent = item.summary || "No summary yet.";

    const why = document.createElement("p");
    why.className = "next-project-why";
    why.textContent = item.why || "No rationale recorded yet.";

    const nextAction = document.createElement("p");
    nextAction.className = "next-project-action";
    nextAction.textContent = `Next: ${item.nextAction || "Decide whether to keep, park, or start this idea."}`;

    detail.append(summary, why, nextAction);
    row.append(detail);
  }

  return row;
}

// The What's next list has no section-wide collapse; each suggestion row
// expands and collapses on its own.
function renderNextProjects() {
  elements.nextProjects.hidden = state.view !== "next";
  // The panel is rebuilt on every render pass; skip the DOM work while it is
  // hidden behind another tab.
  if (state.view !== "next") return;

  const items = state.nextProjects || [];
  const hiddenCount = Math.max(items.length - NEXT_PROJECT_PREVIEW_LIMIT, 0);
  const visibleItems = state.showAllNextProjects ? items : items.slice(0, NEXT_PROJECT_PREVIEW_LIMIT);

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No project suggestions right now.";
    elements.nextProjectList.replaceChildren(empty);
  } else {
    elements.nextProjectList.replaceChildren(...visibleItems.map(renderNextProject));
  }

  elements.toggleNextProjects.hidden = hiddenCount === 0;
  elements.toggleNextProjects.textContent = state.showAllNextProjects ? "Show fewer" : `Show more (${hiddenCount})`;
}

// Checklists tab, first list: one item per project card's next action.
// Check state is local-only (browser localStorage), it never edits the
// project's own nextAction. Keys include a hash of the nextAction text so
// a changed next action resets its checkbox instead of staying stale-checked.
function hashText(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

function nextStepKey(project) {
  return `${projectId(project)}::${hashText(String(project.nextAction || "").trim())}`;
}

function renderNextStepRow(project) {
  const id = projectId(project);
  const checkKey = nextStepKey(project);
  const checked = state.checkedNextSteps.has(checkKey);
  const expanded = state.expandedNextSteps.has(id);

  const row = document.createElement("div");
  row.className = "check-row";
  if (checked) row.classList.add("is-done");
  if (expanded) row.classList.add("is-open");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "check-box";
  checkbox.checked = checked;
  checkbox.addEventListener("change", () => {
    if (state.checkedNextSteps.has(checkKey)) state.checkedNextSteps.delete(checkKey);
    else state.checkedNextSteps.add(checkKey);
    saveCheckedNextSteps();
    renderChecklistsView();
  });

  // Long next actions are clamped by CSS; clicking the text toggles the
  // full version inline. The card itself stays behind the jump button.
  const body = document.createElement("button");
  body.type = "button";
  body.className = "check-body check-toggle";
  body.setAttribute("aria-expanded", String(expanded));

  const title = document.createElement("span");
  title.className = "check-title";
  title.textContent = project.name || "Untitled project";

  const detail = document.createElement("span");
  detail.className = "check-detail";
  detail.textContent = String(project.nextAction).trim();

  body.append(title, detail);
  body.addEventListener("click", () => {
    if (state.expandedNextSteps.has(id)) state.expandedNextSteps.delete(id);
    else state.expandedNextSteps.add(id);
    renderChecklistsView();
  });

  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "link-pill check-jump";
  jump.textContent = "Project card";
  jump.addEventListener("click", () => focusProjectCard(project));

  row.append(checkbox, body, jump);
  return row;
}

function buildCheckGroup({ name, count, collapsed, onToggle, rows, description }) {
  const group = document.createElement("section");
  group.className = "check-group";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "group-head check-group-head";
  head.setAttribute("aria-expanded", String(!collapsed));

  const chevron = document.createElement("span");
  chevron.className = "group-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "▾";

  const gname = document.createElement("span");
  gname.className = "group-name";
  gname.textContent = name;

  const gcount = document.createElement("span");
  gcount.className = "group-count";
  gcount.textContent = count;

  head.append(chevron, gname, gcount);
  head.addEventListener("click", onToggle);

  group.append(head);

  if (!collapsed) {
    const body = document.createElement("div");
    body.className = "check-group-body";
    if (description) {
      const desc = document.createElement("p");
      desc.className = "check-group-desc";
      desc.textContent = description;
      body.append(desc);
    }
    body.append(...rows);
    group.append(body);
  }

  return group;
}

// Standalone checklist rows (Knowledge Expanders). Unlike next-step rows,
// check state persists server-side into data/checklist.json, so it holds
// across browsers.
async function toggleChecklistItem(item, done) {
  const previous = { done: item.done, doneAt: item.doneAt };
  item.done = done;
  item.doneAt = done ? new Date().toISOString() : null;
  renderChecklistsView();
  try {
    const response = await fetch(`/api/checklist/${encodeURIComponent(item.id)}/${done ? "check" : "uncheck"}`, { method: "POST" });
    if (!response.ok) throw new Error(`Checklist update failed: ${response.status}`);
  } catch (error) {
    item.done = previous.done;
    item.doneAt = previous.doneAt;
    renderChecklistsView();
    showToast(error.message);
  }
}

function renderChecklistItemRow(item) {
  const expanded = state.expandedChecklistItems.has(item.id);

  const row = document.createElement("div");
  row.className = "check-row";
  if (item.done) row.classList.add("is-done");
  if (expanded) row.classList.add("is-open");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "check-box";
  checkbox.checked = Boolean(item.done);
  checkbox.addEventListener("change", () => {
    toggleChecklistItem(item, checkbox.checked);
  });

  const body = document.createElement("button");
  body.type = "button";
  body.className = "check-body check-toggle";
  body.setAttribute("aria-expanded", String(expanded));

  const title = document.createElement("span");
  title.className = "check-title";

  const chevron = document.createElement("span");
  chevron.className = "row-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "›";

  const titleText = document.createElement("span");
  titleText.textContent = item.title || item.id;

  title.append(chevron, titleText);
  body.append(title);

  if (expanded) {
    const parts = [String(item.detail || "").trim()];
    if (item.source) parts.push(`Came up in: ${item.source}`);
    if (item.done && item.doneAt) parts.push(`Done ${compactDate(item.doneAt)}`);
    const detail = document.createElement("span");
    detail.className = "check-detail";
    detail.textContent = parts.filter(Boolean).join(" · ");
    body.append(detail);
  }

  body.addEventListener("click", () => {
    if (state.expandedChecklistItems.has(item.id)) state.expandedChecklistItems.delete(item.id);
    else state.expandedChecklistItems.add(item.id);
    renderChecklistsView();
  });

  row.append(checkbox, body);
  return row;
}

function renderChecklistsView() {
  if (state.view !== "checklists") return;

  const sections = [];

  const items = state.projects
    .filter((project) => !state.hiddenProjects.has(projectId(project)))
    .filter((project) => {
      const action = String(project.nextAction || "").trim();
      return action && !/^none\b/i.test(action);
    })
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

  if (items.length > 0) {
    sections.push(buildCheckGroup({
      name: "Projects Next Steps",
      count: String(items.length),
      collapsed: state.nextStepsCollapsed,
      onToggle: () => {
        state.nextStepsCollapsed = !state.nextStepsCollapsed;
        renderChecklistsView();
      },
      rows: items.map(renderNextStepRow)
    }));
  }

  const checklistItems = Array.isArray(state.checklist?.items) ? state.checklist.items : [];
  if (checklistItems.length > 0) {
    const doneCount = checklistItems.filter((item) => item.done).length;
    sections.push(buildCheckGroup({
      name: state.checklist.title || "Checklist",
      count: `${doneCount}/${checklistItems.length}`,
      collapsed: state.checklistCollapsed,
      onToggle: () => {
        state.checklistCollapsed = !state.checklistCollapsed;
        renderChecklistsView();
      },
      rows: checklistItems.map(renderChecklistItemRow),
      description: state.checklist.description || null
    }));
  }

  if (sections.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No project next steps found.";
    elements.checklistsView.replaceChildren(empty);
    return;
  }

  elements.checklistsView.replaceChildren(...sections);
}

// The count pill on the Waiting PRs rail tab is part of the page base: it
// reflects open PRs from every view, updated straight from the PR poll.
function updatePrsBadge() {
  const count = state.waitingPrs?.prs?.length || 0;
  elements.prsCount.hidden = count === 0;
  elements.prsCount.textContent = String(count);
}

// Draft wins over check state: a draft's checks are informational until the
// PR is marked ready, so the card stays muted either way.
function prCheckBadge(pr) {
  if (pr.isDraft) return createBadge("Draft", "muted", "Draft PR; not ready for review yet");
  if (pr.checkStatus === "failing") return createBadge("Failed", "blocked", "At least one status check failed");
  if (pr.checkStatus === "pending") return createBadge("Pending", "review", "Status checks are still running");
  if (pr.checkStatus === "passing") return createBadge("Success", "completed", "All status checks passed");
  return createBadge("No checks", "muted", "No status checks ran on this PR");
}

function renderPrCard(pr) {
  const card = document.createElement("article");
  card.className = "pr-card";
  card.dataset.check = pr.isDraft ? "draft" : pr.checkStatus;

  const head = document.createElement("div");
  head.className = "pr-head";

  const heading = document.createElement("div");
  const repoRef = document.createElement("p");
  repoRef.className = "pr-repo";
  repoRef.textContent = `${pr.repo}#${pr.number}`;
  const title = document.createElement("h3");
  title.textContent = pr.title || "Untitled PR";
  heading.append(repoRef, title);

  const badges = document.createElement("div");
  badges.className = "badge-row";
  badges.append(prCheckBadge(pr));
  if (pr.reviewDecision) {
    badges.append(createBadge(
      labelize(String(pr.reviewDecision).toLowerCase().replace(/_/g, "-")),
      pr.reviewDecision === "APPROVED" ? "completed" : pr.reviewDecision === "CHANGES_REQUESTED" ? "review" : "",
      "Current review decision on this PR"
    ));
  }
  if (pr.mergeable === "CONFLICTING") badges.append(createBadge("Conflicts", "blocked", "This branch conflicts with its base branch"));

  head.append(heading, badges);

  const meta = document.createElement("p");
  meta.className = "pr-meta";
  meta.textContent = [
    pr.headRefName,
    pr.author ? `by ${pr.author}` : null,
    `updated ${relativeTime(pr.updatedAt)}`
  ].filter(Boolean).join(" · ");

  const links = document.createElement("div");
  links.className = "links pr-links";
  const open = document.createElement("a");
  open.className = "link-pill";
  open.href = pr.url;
  open.target = "_blank";
  open.rel = "noopener";
  open.textContent = "Go to PR";
  links.append(open);

  card.append(head, meta, links);
  return card;
}

function renderPrsView() {
  elements.prsView.hidden = state.view !== "prs";
  // Rebuilt on every render pass; skip the DOM work while hidden behind
  // another tab (the rail pill updates straight from the poll instead).
  if (state.view !== "prs") return;

  if (!state.waitingPrs) {
    const loading = document.createElement("p");
    loading.className = "empty";
    loading.textContent = "Checking GitHub for open PRs...";
    elements.prsView.replaceChildren(loading);
    return;
  }

  const prs = Array.isArray(state.waitingPrs.prs) ? state.waitingPrs.prs : [];
  const errors = Array.isArray(state.waitingPrs.errors) ? state.waitingPrs.errors : [];
  const children = [];

  if (prs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No PRs waiting.";
    children.push(empty);
  } else {
    children.push(...prs.map(renderPrCard));
  }

  errors.forEach((entry) => {
    const note = document.createElement("p");
    note.className = "pr-error";
    note.textContent = entry.repo
      ? `Couldn't check ${entry.repo}: ${entry.message}`
      : "GitHub CLI (gh) is not installed, so open PRs can't be checked.";
    children.push(note);
  });

  elements.prsView.replaceChildren(...children);
}

function render() {
  const [statusLabel, title] = statusLabels[state.statusFilter] || statusLabels.ongoing;
  const visible = getProjectViewProjects();
  elements.viewEyebrow.textContent = statusLabel;
  elements.viewTitle.textContent = title;
  elements.lastUpdated.textContent = state.generatedAt ? `Updated ${compactDate(state.generatedAt)}` : "Not loaded";

  elements.viewTabs.forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.view === state.view);
  });

  elements.statusTabs.forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.statusFilter === state.statusFilter);
  });

  elements.sortTabs.forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.sortMode === state.sortMode);
  });

  const onProjectsView = state.view === "projects";
  elements.controlBand.hidden = !onProjectsView;
  elements.projectsHead.hidden = !onProjectsView;
  elements.checklistsView.hidden = state.view !== "checklists";
  renderChecklistsView();
  renderPrsView();

  renderMetrics();
  renderCompletedPanel();
  renderNextProjects();

  // The Online strip is part of the shared page base: it stays visible on
  // every view tab and ignores the tracked-list source and status filters.
  const onlineProjects = state.projects.filter(isOnlineProject);
  renderOnlineSection(onlineProjects);

  if (state.view === "online") {
    if (onlineProjects.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No online projects are configured yet.";
      elements.list.replaceChildren(empty);
    } else {
      renderOnlineDetailList(onlineProjects);
    }
    return;
  }

  if (state.view === "next" || state.view === "checklists" || state.view === "prs") {
    elements.list.replaceChildren();
    return;
  }

  updateGroupToggle(visible);

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No projects match this view.";
    elements.list.replaceChildren(empty);
    return;
  }

  renderGroupedList(elements.list, visible);
}

async function loadNextProjects() {
  const response = await fetch("/api/next-projects");
  if (!response.ok) throw new Error(`Next project load failed: ${response.status}`);
  const payload = await response.json();
  // Dismissed and started suggestions leave the list; the file keeps them
  // (status flip only), so restoring a dismissal is a hand edit there.
  state.nextProjects = (Array.isArray(payload.suggestions) ? payload.suggestions : [])
    .filter((item) => !["dismissed", "started"].includes(String(item.status || "").toLowerCase()));
  renderNextProjects();
}

async function loadWaitingPrs() {
  const response = await fetch("/api/waiting-prs");
  if (!response.ok) throw new Error(`Waiting PR load failed: ${response.status}`);
  state.waitingPrs = await response.json();
  updatePrsBadge();
  renderPrsView();
}

async function loadChecklist() {
  const response = await fetch("/api/checklist");
  if (!response.ok) throw new Error(`Checklist load failed: ${response.status}`);
  state.checklist = await response.json();
  renderChecklistsView();
}

async function loadProjects({ includeHealth = false, quiet = false, force = false } = {}) {
  if (state.loadingProjects && !force) return state.loadingProjects;

  state.lastProjectLoadStartedAt = Date.now();
  const requestVersion = state.projectLoadVersion + 1;
  state.projectLoadVersion = requestVersion;
  if (!quiet) elements.lastUpdated.textContent = "Loading...";

  const currentLoad = (async () => {
    const response = await fetch(`/api/projects?git=1&health=${includeHealth ? "1" : "0"}`);
    if (!response.ok) throw new Error(`Project load failed: ${response.status}`);
    const payload = await response.json();
    if (requestVersion !== state.projectLoadVersion) return;
    const incoming = payload.projects || [];
    // Health only travels on health=1 responses; remember the last result per
    // project so the regular polls do not blank out the Online section.
    incoming.forEach((project) => {
      if (project.health) state.healthById.set(projectId(project), project.health);
    });
    state.projects = annotateProjectRelationships(incoming).map((project) => (
      project.health ? project : { ...project, health: state.healthById.get(projectId(project)) || null }
    ));
    applyServerHiddenList(payload.hiddenProjects);
    applyCapabilities(payload.capabilities);
    state.generatedAt = payload.generatedAt;
    render();
  })();
  state.loadingProjects = currentLoad;

  try {
    await currentLoad;
  } finally {
    if (state.loadingProjects === currentLoad) {
      state.loadingProjects = null;
    }
  }
}

function refreshProjectsIfVisible() {
  if (document.hidden) return;
  loadProjects({ quiet: true }).catch((error) => {
    showToast(error.message);
  });
}

function refreshProjectsOnFocus() {
  if (Date.now() - state.lastProjectLoadStartedAt < FOCUS_REFRESH_STALE_MS) return;
  refreshProjectsIfVisible();
}

async function refreshHealth() {
  elements.refreshHealth.disabled = true;
  elements.refreshHealth.textContent = "Checking...";
  try {
    await loadProjects({ includeHealth: true, force: true });
  } finally {
    elements.refreshHealth.disabled = false;
    elements.refreshHealth.textContent = "Check live sites";
  }
}

// Show server-dependent controls only when the server says it supports them.
// The restart button is useless (and misleading) unless a supervisor will
// relaunch the process, so it stays hidden until the capability is advertised.
function applyCapabilities(capabilities) {
  const canRestart = Boolean(capabilities && capabilities.restart);
  elements.restartServer.hidden = !canRestart;
}

async function restartServer() {
  if (!window.confirm("Restart the dashboard server? It goes down for a few seconds, then reloads here automatically.")) return;
  elements.restartServer.disabled = true;
  elements.restartServer.textContent = "Restarting...";
  elements.lastUpdated.textContent = "Restarting server...";
  try {
    const response = await fetch("/api/restart", { method: "POST" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Restart failed: ${response.status}`);
    }
  } catch (error) {
    // A dropped connection as the process exits is expected; the poll below is
    // the real signal for whether the fresh process came back.
    if (error instanceof TypeError) {
      // network error mid-exit — fall through to polling
    } else {
      elements.restartServer.disabled = false;
      elements.restartServer.textContent = "Restart server";
      elements.lastUpdated.textContent = error.message;
      return;
    }
  }

  // Poll until the relaunched process answers, then reload everything.
  const deadline = Date.now() + 30000;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  let back = false;
  while (Date.now() < deadline) {
    try {
      const ping = await fetch("/api/projects?git=0&health=0", { cache: "no-store" });
      if (ping.ok) { back = true; break; }
    } catch {
      // still down; keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  elements.restartServer.disabled = false;
  elements.restartServer.textContent = "Restart server";
  if (!back) {
    elements.lastUpdated.textContent = "Server did not come back within 30s — check the LaunchAgent.";
    return;
  }
  await Promise.all([
    loadProjects({ force: true }),
    loadNextProjects().catch(() => {}),
    loadChecklist().catch(() => {})
  ]);
}

async function syncAndLoadProjects() {
  elements.refreshProjects.disabled = true;
  elements.refreshProjects.textContent = "Syncing...";
  elements.lastUpdated.textContent = "Syncing projects...";
  try {
    const response = await fetch("/api/sync", { method: "POST" });
    if (!response.ok) throw new Error(`Sync failed: ${response.status}`);
    await Promise.all([
      loadProjects({ force: true }),
      loadNextProjects(),
      loadChecklist()
    ]);
  } finally {
    elements.refreshProjects.disabled = false;
    elements.refreshProjects.textContent = "Refresh projects";
  }
}

elements.viewTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    localStorage.setItem("dashboard-view", state.view);
    render();
  });
});

elements.statusTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    state.statusFilter = tab.dataset.statusFilter;
    render();
  });
});

elements.sortTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    state.sortMode = tab.dataset.sortMode;
    render();
  });
});

elements.search.addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  render();
});
document.addEventListener("click", () => {
  if (!state.activeMenuProjectId) return;
  state.activeMenuProjectId = null;
  state.moveMenuProjectId = null;
  render();
});

elements.refreshProjects.addEventListener("click", syncAndLoadProjects);
elements.refreshHealth.addEventListener("click", refreshHealth);
elements.restartServer.addEventListener("click", restartServer);
elements.themeToggle.addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  localStorage.setItem("dashboard-theme", state.theme);
  applyTheme();
});
elements.toggleCompleted.addEventListener("click", () => {
  state.showAllCompleted = !state.showAllCompleted;
  render();
});
elements.toggleNextProjects.addEventListener("click", () => {
  state.showAllNextProjects = !state.showAllNextProjects;
  renderNextProjects();
});
elements.toggleGroups.addEventListener("click", () => {
  const visible = getProjectViewProjects();
  const keys = groupKeysOf(visible);
  const projectIds = projectIdsOf(visible);

  if (allVisibleExpanded(visible)) {
    keys.forEach((key) => state.collapsedGroups.add(key));
    projectIds.forEach((id) => state.expandedProjects.delete(id));
  } else {
    keys.forEach((key) => state.collapsedGroups.delete(key));
    projectIds.forEach((id) => state.expandedProjects.add(id));
  }

  render();
});
elements.backToTop.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});
window.addEventListener("scroll", updateBackToTop, { passive: true });
window.addEventListener("focus", refreshProjectsOnFocus);
document.addEventListener("visibilitychange", refreshProjectsOnFocus);
window.setInterval(refreshProjectsIfVisible, AUTO_REFRESH_MS);

applyTheme();
updateBackToTop();

loadNextProjects().catch((error) => {
  showToast(error.message);
});

loadChecklist().catch((error) => {
  showToast(error.message);
});

loadWaitingPrs().catch((error) => {
  showToast(error.message);
});

// The rail pill must stay honest from every view, so the PR poll runs on its
// own clock regardless of the active tab; a failed poll keeps the last state
// silently instead of toasting every minute.
window.setInterval(() => {
  loadWaitingPrs().catch(() => {});
}, PRS_REFRESH_MS);

loadProjects().then(() => {
  // Fill the Online section with real statuses without delaying first paint.
  return loadProjects({ includeHealth: true, quiet: true, force: true });
}).catch((error) => {
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = error.message;
  elements.list.replaceChildren(empty);
});
