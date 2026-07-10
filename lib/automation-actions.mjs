import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTOMATIONS_DIR, parseSimpleToml } from "./project-sync.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(ROOT_DIR, "data", "automation-runs");
const STATUS_BACKUP_PATH = path.join(ROOT_DIR, "data", "automation-status-backup.json");
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const LOG_TAIL_CHARS = 4000;
// The Codex CLI ships inside the ChatGPT desktop app and is usually not on
// PATH, so fall back to the app bundle when no standalone install exists.
const CODEX_APP_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";

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

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
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
export async function setAutomationStatus(requestedId, action) {
  const automation = await findAutomation(requestedId);
  if (!automation) return null;

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

async function resolveCodexBinary() {
  for (const dir of (process.env.PATH || "").split(":").filter(Boolean)) {
    const candidate = path.join(dir, "codex");
    if (await pathExists(candidate)) return candidate;
  }
  if (await pathExists(CODEX_APP_BINARY)) return CODEX_APP_BINARY;
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

// Reproduces the automation's work via `codex exec` with its own prompt,
// model, effort, and first cwd. Codex has no external trigger for the real
// automation record, so this run will not appear in the app's own history.
export async function runAutomation(requestedId) {
  const automation = await findAutomation(requestedId);
  if (!automation) return null;

  if (activeRuns.has(automation.id)) {
    throw runError(`Automation "${automation.id}" is already running`, "RUN_ACTIVE");
  }

  const prompt = automation.data.prompt;
  if (!prompt) {
    throw runError(`Automation "${automation.id}" has no prompt to run`, "NO_PROMPT");
  }

  const codexBinary = await resolveCodexBinary();
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

  const startedAt = new Date().toISOString();
  const runDir = path.join(RUNS_DIR, automation.id);
  await mkdir(runDir, { recursive: true });
  const logPath = path.join(runDir, `${startedAt.replace(/[:.]/g, "-")}.log`);
  const metaPath = logPath.replace(/\.log$/, ".json");

  const logFd = openSync(logPath, "a");
  let child;
  try {
    // Detached so a dashboard-server restart does not kill an in-flight run.
    child = spawn(codexBinary, args, { cwd, detached: true, stdio: ["ignore", logFd, logFd] });
  } finally {
    closeSync(logFd);
  }

  const meta = { id: automation.id, startedAt, status: "running", pid: child.pid, logPath, codexBinary };
  activeRuns.set(automation.id, meta);
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
    activeRuns.delete(automation.id);
    writeRunMeta(metaPath, { ...meta, status: "failed", finishedAt: new Date().toISOString(), error: error.message });
  });

  child.on("exit", (exitCode, signal) => {
    clearTimeout(timeout);
    activeRuns.delete(automation.id);
    writeRunMeta(metaPath, {
      ...meta,
      status: exitCode === 0 ? "succeeded" : "failed",
      finishedAt: new Date().toISOString(),
      exitCode,
      signal: signal || null
    });
  });

  child.unref();
  return { id: automation.id, startedAt, logPath };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function getLastRun(requestedId) {
  const automation = await findAutomation(requestedId);
  if (!automation) return null;

  const active = activeRuns.get(automation.id);
  let run = active ? { ...active } : null;

  if (!run) {
    const runDir = path.join(RUNS_DIR, automation.id);
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

  return { id: automation.id, run };
}
