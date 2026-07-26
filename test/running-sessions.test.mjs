import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  classifyCommand,
  collectSessions,
  encodeCwdForTranscripts,
  extractLastUserPrompt,
  parseElapsed,
  parsePsLine
} from "../lib/running-sessions.mjs";

// Command lines that are real agent sessions, and the kind each one is.
const AGENT_COMMANDS = [
  ["/Users/avi/.local/bin/claude", "claude", false],
  ["claude --model opus", "claude", false],
  ["claude -p Update the status file", "claude", true],
  ["node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js", "claude", false],
  ["/usr/local/bin/codex", "codex", false],
  ["codex exec --model gpt-5 Run the nightly sweep", "codex", true]
];

// Command lines that merely mention the agents. The desktop app and its
// Electron helpers are the ones that regress a naive substring match.
const NOT_SESSIONS = [
  "/Applications/Claude.app/Contents/MacOS/Claude",
  "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)",
  "/usr/bin/tail -f /Users/avi/.claude/projects/-Users-avi-dev-app/session.jsonl",
  "node /Users/avi/dev/claude-dashboard/server.mjs",
  "vim claude-notes.md",
  ""
];

let fixtureDir;
let previousProjectsDir;

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "dashboard-sessions-"));
  process.env.CLAUDE_PROJECTS_DIR = path.join(fixtureDir, "projects");
  previousProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
});

after(async () => {
  if (previousProjectsDir === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
  await rm(fixtureDir, { recursive: true, force: true });
});

async function writeTranscript(cwd, lines) {
  const dir = path.join(process.env.CLAUDE_PROJECTS_DIR, encodeCwdForTranscripts(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "session.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"));
}

test("classifies agent CLIs by executable and script, not by name substring", () => {
  for (const [command, kind, headless] of AGENT_COMMANDS) {
    const result = classifyCommand(command);
    assert.ok(result, `${command} should classify as a session`);
    assert.equal(result.kind, kind);
    assert.equal(result.headless, headless);
  }
});

test("ignores the desktop app, its helpers, and unrelated processes", () => {
  for (const command of NOT_SESSIONS) {
    assert.equal(classifyCommand(command), null, `${command} should not classify as a session`);
  }
});

test("parses a ps line, keeping the command's own spaces intact", () => {
  const parsed = parsePsLine(" 4821  1  12.5 524288    02:15:09 ttys004  claude -p Do the thing");
  assert.deepEqual(parsed, {
    pid: 4821,
    ppid: 1,
    cpuPercent: 12.5,
    memoryMb: 512,
    elapsedSeconds: 8109,
    tty: "ttys004",
    command: "claude -p Do the thing"
  });
});

test("reads a headless session's missing tty as no tty", () => {
  assert.equal(parsePsLine("101 1 0.0 1024 05:00 ?? claude -p go").tty, null);
});

test("parses every ps elapsed-time shape", () => {
  assert.equal(parseElapsed("00:42"), 42);
  assert.equal(parseElapsed("07:30"), 450);
  assert.equal(parseElapsed("02:15:09"), 8109);
  assert.equal(parseElapsed("3-04:05:06"), 273906);
  assert.equal(parseElapsed("not-a-time"), null);
});

test("encodes a cwd the way Claude Code names its transcript directory", () => {
  assert.equal(encodeCwdForTranscripts("/Users/avi/dev/my_app"), "-Users-avi-dev-my-app");
});

test("extracts the last real user prompt, skipping tool results and plumbing", () => {
  const transcript = [
    { type: "user", message: { role: "user", content: "First question" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Answer" }] } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "Second question" }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "exit 0" }] } },
    { type: "user", isMeta: true, message: { role: "user", content: "session metadata" } },
    { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }
  ].map((entry) => JSON.stringify(entry)).join("\n");

  assert.equal(extractLastUserPrompt(transcript), "Second question");
});

test("returns no prompt when the transcript holds nothing a person typed", () => {
  assert.equal(extractLastUserPrompt(""), null);
  assert.equal(extractLastUserPrompt("not json\n{broken"), null);
});

test("attributes a session to the deepest tracked project containing its cwd", async () => {
  const projects = [
    { id: "outer", name: "Workspace", localPath: "/Users/avi/dev" },
    { id: "inner", name: "Dashboard", localPath: "/Users/avi/dev/dashboard" }
  ];
  const [session] = await collectSessions(
    [{ pid: 1, ppid: 0, kind: "claude", headless: false, cwd: "/Users/avi/dev/dashboard/lib", elapsedSeconds: 60, cpuPercent: 1, memoryMb: 10, tty: "ttys001", command: "claude" }],
    projects
  );
  assert.equal(session.projectId, "inner");
  assert.equal(session.projectName, "Dashboard");
  assert.equal(session.folder, "lib");
});

test("leaves an untracked folder unattributed instead of guessing a project", async () => {
  const [session] = await collectSessions(
    [{ pid: 2, ppid: 0, kind: "claude", headless: false, cwd: "/tmp/scratch", elapsedSeconds: 30, cpuPercent: 0, memoryMb: 8, tty: null, command: "claude" }],
    [{ id: "inner", name: "Dashboard", localPath: "/Users/avi/dev/dashboard" }]
  );
  assert.equal(session.projectId, null);
  assert.equal(session.projectName, null);
});

test("attaches the transcript prompt to a lone session in a folder", async () => {
  const cwd = path.join(fixtureDir, "lone-project");
  await writeTranscript(cwd, [{ type: "user", message: { role: "user", content: "Fix the sync guard" } }]);

  const [session] = await collectSessions(
    [{ pid: 3, ppid: 0, kind: "claude", headless: false, cwd, elapsedSeconds: 120, cpuPercent: 2, memoryMb: 64, tty: "ttys002", command: "claude" }],
    []
  );
  assert.equal(session.lastPrompt, "Fix the sync guard");
  assert.ok(session.lastActivityAt);
  assert.equal(session.transcriptNote, null);
});

test("declines to guess whose transcript is whose when a folder has two sessions", async () => {
  const cwd = path.join(fixtureDir, "shared-project");
  await writeTranscript(cwd, [{ type: "user", message: { role: "user", content: "Which session am I?" } }]);

  const sessions = await collectSessions(
    [
      { pid: 4, ppid: 0, kind: "claude", headless: false, cwd, elapsedSeconds: 60, cpuPercent: 1, memoryMb: 32, tty: "ttys003", command: "claude" },
      { pid: 5, ppid: 0, kind: "claude", headless: true, cwd, elapsedSeconds: 20, cpuPercent: 3, memoryMb: 48, tty: null, command: "claude -p go" }
    ],
    []
  );
  for (const session of sessions) {
    assert.equal(session.lastPrompt, null);
    assert.equal(session.transcriptNote, "More than one session is running in this folder");
  }
});

test("derives a start instant from elapsed time", async () => {
  const now = Date.parse("2026-07-26T12:00:00.000Z");
  const [session] = await collectSessions(
    [{ pid: 6, ppid: 0, kind: "codex", headless: false, cwd: "/tmp/none", elapsedSeconds: 3600, cpuPercent: 0, memoryMb: 12, tty: "ttys004", command: "codex" }],
    [],
    now
  );
  assert.equal(session.startedAt, "2026-07-26T11:00:00.000Z");
  assert.equal(session.transcriptNote, "Transcripts are only read for Claude Code sessions");
});

test("sorts the freshest session first", async () => {
  const busyCwd = path.join(fixtureDir, "busy-project");
  await writeTranscript(busyCwd, [{ type: "user", message: { role: "user", content: "Working right now" } }]);
  const now = Date.parse("2026-07-26T12:00:00.000Z");

  const sessions = await collectSessions(
    [
      { pid: 7, ppid: 0, kind: "claude", headless: false, cwd: "/tmp/old", elapsedSeconds: 86400, cpuPercent: 0, memoryMb: 20, tty: "ttys005", command: "claude" },
      { pid: 8, ppid: 0, kind: "claude", headless: false, cwd: busyCwd, elapsedSeconds: 60, cpuPercent: 5, memoryMb: 90, tty: "ttys006", command: "claude" }
    ],
    [],
    now
  );
  assert.deepEqual(sessions.map((session) => session.pid), [8, 7]);
});
