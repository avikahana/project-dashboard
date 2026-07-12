import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic } from "./json-files.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const NEXT_PROJECTS_PATH = path.join(DATA_DIR, "next-projects.json");
const SOURCES_PATH = path.join(DATA_DIR, "dashboard.sources.json");

async function readSuggestions() {
  const payload = await readJson(NEXT_PROJECTS_PATH, { suggestions: [] });
  if (!Array.isArray(payload.suggestions)) payload.suggestions = [];
  return payload;
}

async function saveSuggestionStatus(payload, suggestion, status) {
  suggestion.status = status;
  await writeJsonAtomic(NEXT_PROJECTS_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function findSuggestion(payload, suggestionId) {
  return payload.suggestions.find((entry) => entry.id === suggestionId) || null;
}

// Where "Start" creates new project homes: an explicit env override, else the
// first configured scan root (so the new home lands somewhere sync picks up).
async function newProjectRoot() {
  const fromEnv = String(process.env.DASHBOARD_NEW_PROJECT_ROOT || "").trim();
  if (fromEnv) return fromEnv;
  const sources = await readJson(SOURCES_PATH, { sources: [] });
  const first = (sources.sources || []).find((source) => source.rootPath);
  return first ? first.rootPath : null;
}

function slugify(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function dismissSuggestion(suggestionId) {
  const payload = await readSuggestions();
  const suggestion = findSuggestion(payload, suggestionId);
  if (!suggestion) return null;
  await saveSuggestionStatus(payload, suggestion, "dismissed");
  return { suggestion };
}

// Promotes a suggestion to a tracked planning project: creates the project
// home folder with a fresh .project-status.json (nothing else; the first real
// work session writes START-HERE.md and friends with actual content).
export async function startSuggestion(suggestionId) {
  const payload = await readSuggestions();
  const suggestion = findSuggestion(payload, suggestionId);
  if (!suggestion) return null;

  const root = await newProjectRoot();
  if (!root) {
    const error = new Error("No project root configured: set data/dashboard.sources.json or DASHBOARD_NEW_PROJECT_ROOT");
    error.code = "NO_ROOT";
    throw error;
  }

  const slug = slugify(suggestion.title) || slugify(suggestion.id);
  if (!slug) {
    const error = new Error(`Suggestion "${suggestionId}" has no usable title`);
    error.code = "NO_SLUG";
    throw error;
  }

  const projectPath = path.join(root, slug);
  const exists = await stat(projectPath).then(() => true, () => false);
  if (exists) {
    const error = new Error(`Folder already exists: ${projectPath}`);
    error.code = "EEXISTS";
    throw error;
  }

  const now = new Date().toISOString();
  const statusFile = {
    name: suggestion.title || slug,
    status: "planning",
    type: "project",
    projectHome: projectPath,
    progress: 8,
    phase: "planning",
    confidence: "medium",
    nextAction: suggestion.nextAction || "Draft the project spec.",
    notes: [suggestion.summary, suggestion.why].filter(Boolean).join(" Why now: ") || null,
    completedAt: null,
    updatedAt: now,
    tags: [suggestion.category].filter(Boolean).map((tag) => String(tag).toLowerCase()),
    milestones: [
      { name: "Project home created", done: true },
      { name: "Spec drafted", done: false },
      { name: "Implementation started", done: false }
    ]
  };

  await mkdir(projectPath, { recursive: true });
  const statusPath = path.join(projectPath, ".project-status.json");
  await writeFile(statusPath, `${JSON.stringify(statusFile, null, 2)}\n`, { flag: "wx" });

  await saveSuggestionStatus(payload, suggestion, "started");
  return { suggestion, projectPath };
}
