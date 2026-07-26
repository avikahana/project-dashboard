import { execFile } from "node:child_process";
import { open, readdir, readlink, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";

// "Which agent sessions are alive on this machine right now" has exactly one
// truthful source: the process table. Transcript files on disk only say a
// session once existed, so they are used as enrichment (what it is working on)
// and never as the liveness signal itself.
const PS_TIMEOUT_MS = 5000;
const LSOF_TIMEOUT_MS = 5000;

// The frontend polls this from every open tab and each poll shells out to ps
// (plus lsof on macOS), so one in-flight scan serves all callers. The TTL is
// short because the whole point of the view is that it is live.
const SESSIONS_CACHE_TTL_MS = 5000;
let sessionsCache = { at: 0, promise: null };

// Claude Code writes one JSONL transcript per session under a directory named
// after the session's cwd. Overridable so the test suite can point at a fixture.
function claudeProjectsDir() {
  return process.env.CLAUDE_PROJECTS_DIR || path.join(homedir(), ".claude", "projects");
}

const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
const MAX_PROMPT_CHARS = 280;
const MAX_COMMAND_CHARS = 220;

function execCapture(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          notInstalled: error.code === "ENOENT",
          message: String(stderr || "").trim() || error.message
        });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });
}

// ps reports elapsed time as [[dd-]hh:]mm:ss. Turning it into a start instant
// (rather than shipping the string) lets the UI age it the same way every other
// timestamp on the board is aged.
export function parseElapsed(value) {
  const match = String(value || "").trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days || 0) * 86400
    + Number(hours || 0) * 3600
    + Number(minutes || 0) * 60
    + Number(seconds || 0);
}

// One ps line, `command` last so everything after the fixed columns is the
// command itself (which is the only field that can contain spaces).
export function parsePsLine(line) {
  const match = String(line).trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
  if (!match) return null;
  const [, pid, ppid, cpu, rss, elapsed, tty, command] = match;
  if (!command) return null;
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    cpuPercent: Number(cpu) || 0,
    memoryMb: Math.round(Number(rss) / 1024),
    elapsedSeconds: parseElapsed(elapsed),
    tty: tty === "??" || tty === "?" ? null : tty,
    command
  };
}

// A quoted argument containing spaces (a `-p` prompt) splits into several
// tokens here. That is fine: classification only reads argv[0], the script
// path, and flag-shaped tokens.
function tokenize(command) {
  return String(command).trim().split(/\s+/).filter(Boolean);
}

const JS_RUNTIMES = new Set(["node", "node.exe", "bun", "deno"]);
// The Claude desktop app and its Electron helpers live inside a bundle and are
// not agent sessions, so bundle paths are excluded structurally rather than by
// matching on the word "Claude".
const APP_BUNDLE = /\.app\/Contents\//;
const CLAUDE_CLI_SCRIPT = /(^|\/)claude-code\/cli\.js$/;
const CODEX_CLI_SCRIPT = /(^|\/)codex(-cli)?\/(bin\/)?codex(\.js)?$/;

// Returns the agent kind this command line is running, or null when it is not
// an agent session at all.
export function classifyCommand(command) {
  const tokens = tokenize(command);
  if (tokens.length === 0) return null;

  const executable = tokens[0];
  if (APP_BUNDLE.test(executable)) return null;

  const name = path.basename(executable);
  let kind = null;
  if (name === "claude") kind = "claude";
  else if (name === "codex") kind = "codex";
  else if (JS_RUNTIMES.has(name)) {
    // A runtime tells us nothing; the script it was handed does.
    const script = tokens.slice(1).find((token) => !token.startsWith("-"));
    if (script && !APP_BUNDLE.test(script)) {
      if (CLAUDE_CLI_SCRIPT.test(script) || path.basename(script) === "claude") kind = "claude";
      else if (CODEX_CLI_SCRIPT.test(script) || path.basename(script) === "codex") kind = "codex";
    }
  }
  if (!kind) return null;

  // `-p` / `--print` is the non-interactive form: a scheduled run, a hook, or
  // something the dashboard's own "Run now" button launched.
  const headless = tokens.slice(1).some((token) => token === "-p" || token === "--print" || token === "exec");
  return { kind, headless };
}

async function resolveCwd(pid) {
  // Linux exposes cwd directly; macOS needs lsof, so /proc is tried first and
  // costs nothing where it does not exist.
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

async function resolveCwdsWithLsof(pids) {
  const result = await execCapture("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"], LSOF_TIMEOUT_MS);
  const cwds = new Map();
  if (!result.ok) return cwds;

  let currentPid = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p")) currentPid = Number(line.slice(1));
    else if (line.startsWith("n") && currentPid !== null) cwds.set(currentPid, line.slice(1));
  }
  return cwds;
}

async function listAgentProcesses() {
  const result = await execCapture(
    "ps",
    ["-Ao", "pid=,ppid=,pcpu=,rss=,etime=,tty=,command="],
    PS_TIMEOUT_MS
  );
  if (!result.ok) {
    return {
      processes: [],
      error: result.notInstalled
        ? "ps is not available on this machine, so running sessions can't be listed."
        : `Couldn't read the process table: ${result.message}`
    };
  }

  const candidates = [];
  for (const line of result.stdout.split("\n")) {
    const parsed = parsePsLine(line);
    if (!parsed || parsed.pid === process.pid) continue;
    const classified = classifyCommand(parsed.command);
    if (!classified) continue;
    candidates.push({ ...parsed, ...classified });
  }

  // A CLI that re-execs itself (wrapper script -> real binary) shows up twice.
  // The parent is the session; a matched process whose parent also matched is
  // that same session counted again.
  const pids = new Set(candidates.map((candidate) => candidate.pid));
  const processes = candidates.filter((candidate) => !pids.has(candidate.ppid));

  const missing = [];
  for (const entry of processes) {
    entry.cwd = await resolveCwd(entry.pid);
    if (!entry.cwd) missing.push(entry.pid);
  }
  if (missing.length > 0) {
    const cwds = await resolveCwdsWithLsof(missing);
    for (const entry of processes) {
      if (!entry.cwd) entry.cwd = cwds.get(entry.pid) || null;
    }
  }

  return { processes, error: null };
}

// Claude Code names a transcript directory after the session cwd with every
// non-alphanumeric character replaced by a dash.
export function encodeCwdForTranscripts(cwd) {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

async function readTail(file, bytes) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // A mid-line start byte leaves a partial first line; it can't be parsed.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

// Transcript lines that are user-shaped but not something the person typed:
// tool results, slash-command plumbing, and the CLI's own preamble.
const SYNTHETIC_PROMPT = /^(<(command-|local-command|user-memory|system-reminder|bash-)|Caveat: )/;

export function extractLastUserPrompt(text) {
  const lines = String(text).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.isMeta || entry.type !== "user") continue;

    const content = entry.message?.content;
    const prompt = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
        : "";

    const trimmed = prompt.trim();
    if (!trimmed || SYNTHETIC_PROMPT.test(trimmed)) continue;
    return trimmed.length > MAX_PROMPT_CHARS ? `${trimmed.slice(0, MAX_PROMPT_CHARS)}...` : trimmed;
  }
  return null;
}

async function readTranscript(cwd) {
  const dir = path.join(claudeProjectsDir(), encodeCwdForTranscripts(cwd));
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  let latest = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    const stats = await stat(file).catch(() => null);
    if (!stats?.isFile()) continue;
    if (!latest || stats.mtimeMs > latest.mtimeMs) latest = { file, mtimeMs: stats.mtimeMs };
  }
  if (!latest) return null;

  const tail = await readTail(latest.file, TRANSCRIPT_TAIL_BYTES).catch(() => "");
  return {
    lastActivityAt: new Date(latest.mtimeMs).toISOString(),
    lastPrompt: extractLastUserPrompt(tail)
  };
}

// The tracked project a session is working inside: the deepest configured
// localPath that contains the session cwd, so a repo nested under another
// project's root still attributes to the nearer one.
function matchProject(cwd, projects) {
  if (!cwd) return null;
  let best = null;
  for (const project of projects) {
    const root = project.localPath;
    if (!root) continue;
    if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) continue;
    if (!best || root.length > best.localPath.length) best = project;
  }
  return best;
}

function truncateCommand(command) {
  const value = String(command);
  return value.length > MAX_COMMAND_CHARS ? `${value.slice(0, MAX_COMMAND_CHARS)}...` : value;
}

// Exported for the test suite: everything past the process table is pure
// bookkeeping plus transcript reads, both of which are drivable from fixtures.
export async function collectSessions(processes, projects, now = Date.now()) {
  // Two sessions open in the same folder share one transcript directory, and
  // nothing on disk says which JSONL belongs to which pid. Reporting either
  // one's prompt against both would be a guess, so the enrichment is dropped.
  const perCwd = new Map();
  for (const entry of processes) {
    if (entry.cwd) perCwd.set(entry.cwd, (perCwd.get(entry.cwd) || 0) + 1);
  }

  const sessions = await Promise.all(processes.map(async (entry) => {
    const project = matchProject(entry.cwd, projects);
    const shared = entry.cwd ? perCwd.get(entry.cwd) > 1 : false;
    const transcript = entry.kind === "claude" && entry.cwd && !shared
      ? await readTranscript(entry.cwd)
      : null;

    return {
      pid: entry.pid,
      kind: entry.kind,
      headless: entry.headless,
      cwd: entry.cwd,
      folder: entry.cwd ? path.basename(entry.cwd) : null,
      projectId: project?.id || null,
      projectName: project?.name || null,
      startedAt: entry.elapsedSeconds === null
        ? null
        : new Date(now - entry.elapsedSeconds * 1000).toISOString(),
      elapsedSeconds: entry.elapsedSeconds,
      cpuPercent: entry.cpuPercent,
      memoryMb: entry.memoryMb,
      tty: entry.tty,
      command: truncateCommand(entry.command),
      lastActivityAt: transcript?.lastActivityAt || null,
      lastPrompt: transcript?.lastPrompt || null,
      // Why a Claude session shows no prompt, so the blank is explained rather
      // than read as "this session is idle".
      transcriptNote: entry.kind !== "claude"
        ? "Transcripts are only read for Claude Code sessions"
        : shared
          ? "More than one session is running in this folder"
          : transcript
            ? null
            : "No transcript on disk for this folder yet"
    };
  }));

  // Freshest first: last transcript activity when there is one, start time
  // otherwise, so the session you just typed into sits at the top.
  return sessions.sort((a, b) => {
    const left = a.lastActivityAt || a.startedAt || "";
    const right = b.lastActivityAt || b.startedAt || "";
    return String(right).localeCompare(String(left));
  });
}

async function loadRunningSessions(projects) {
  const { processes, error } = await listAgentProcesses();
  const errors = error ? [{ message: error }] : [];

  const sessions = await collectSessions(processes, projects);
  // Without a cwd there is no project, no transcript, and no folder to show.
  // On macOS that means lsof was unavailable or denied.
  if (sessions.some((session) => !session.cwd)) {
    errors.push({ message: "Some sessions' working directories couldn't be read (lsof unavailable or denied)." });
  }

  return {
    generatedAt: new Date().toISOString(),
    platform: platform(),
    sessions,
    errors
  };
}

export function getRunningSessions(projects) {
  const fresh = sessionsCache.promise && Date.now() - sessionsCache.at < SESSIONS_CACHE_TTL_MS;
  if (fresh) return sessionsCache.promise;

  const promise = loadRunningSessions(projects);
  promise.catch(() => {
    if (sessionsCache.promise === promise) {
      sessionsCache = { at: 0, promise: null };
    }
  });
  sessionsCache = { at: Date.now(), promise };
  return promise;
}
