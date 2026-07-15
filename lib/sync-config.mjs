import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./json-files.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");
export const CONFIG_PATH = path.join(ROOT_DIR, "data", "dashboard.config.json");
export const SOURCES_PATH = path.join(ROOT_DIR, "data", "dashboard.sources.json");
export const STATUS_FILE = ".project-status.json";
export const AUTOMATIONS_DIR = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, "automations")
  : path.join(homedir(), ".codex", "automations");

// Source roots are machine-specific and live in data/dashboard.sources.json
// (gitignored). With no sources configured, sync discovers nothing new but
// still refreshes retained projects and Codex automations.
export const DEFAULT_SOURCES = [];

export const IGNORE_NAMES = new Set([
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

export function slugify(value) {
  return String(value || "project")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
}

export function titleize(value) {
  return String(value || "Project")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

export async function pathExists(targetPath) {
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
export async function readConfigForSync() {
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

export async function readSources() {
  const configured = await readJson(SOURCES_PATH);
  const sources = Array.isArray(configured?.sources) ? configured.sources : DEFAULT_SOURCES;
  return sources.filter((source) => source.rootPath && source.id);
}
