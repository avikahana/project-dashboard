import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { discoverProjects } from "../lib/discovery.mjs";

// Real project homes that must survive discovery. The first four regressed while
// shouldIgnoreDirectory matched "archive" as a substring, which is the specific
// bug this suite exists to prevent from coming back.
const DISCOVERABLE = [
  "archive-tool",
  "data-archiver",
  "archive-explorer",
  "unarchiver",
  "my-project"
];

// Names that must never turn into project cards on the dashboard.
const IGNORED = [
  ".cursor",                    // tool config; the false positive that started this
  ".claude",
  ".git",
  ".venv",
  ".date_backup_2026",
  "_tools",                     // workspace infrastructure
  "_templates",
  "archive",                    // retired-project holders, matched exactly
  "Archives",
  "ARCHIVED",
  "foo-archived-2026-01-01",    // the dated retirement convention
  "bar.archived-2026-01-01",
  "node_modules",
  "__pycache__",
  "venv"
];

let fixtureDir;
let previousSources;

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "dashboard-discovery-"));
  const rootPath = path.join(fixtureDir, "fixture-root");
  await mkdir(rootPath);
  for (const name of [...DISCOVERABLE, ...IGNORED]) {
    await mkdir(path.join(rootPath, name));
  }
  // A stray file at the root must not be mistaken for a project home.
  await writeFile(path.join(rootPath, ".DS_Store"), "");

  const sourcesFile = path.join(fixtureDir, "dashboard.sources.json");
  await writeFile(sourcesFile, JSON.stringify({ sources: [{ id: "fixture", rootPath }] }));

  previousSources = process.env.DASHBOARD_SOURCES;
  process.env.DASHBOARD_SOURCES = sourcesFile;
});

after(async () => {
  if (previousSources === undefined) {
    delete process.env.DASHBOARD_SOURCES;
  } else {
    process.env.DASHBOARD_SOURCES = previousSources;
  }
  await rm(fixtureDir, { recursive: true, force: true });
});

async function discoveredNames() {
  const { projects } = await discoverProjects();
  return new Set(projects.map((project) => path.basename(project.localPath)));
}

test("discovers projects whose names merely contain archive", async () => {
  const found = await discoveredNames();
  for (const name of DISCOVERABLE) {
    assert.ok(found.has(name), `${name} should be discovered`);
  }
});

test("ignores tool config, workspace infrastructure, and retired projects", async () => {
  const found = await discoveredNames();
  for (const name of IGNORED) {
    assert.ok(!found.has(name), `${name} should be ignored`);
  }
});

test("ignores files at the source root, only directories are project homes", async () => {
  const found = await discoveredNames();
  assert.ok(!found.has(".DS_Store"));
});

test("discovers exactly the expected project set and nothing else", async () => {
  const found = await discoveredNames();
  assert.deepEqual([...found].sort(), [...DISCOVERABLE].sort());
});
