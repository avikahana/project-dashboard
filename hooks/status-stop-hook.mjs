#!/usr/bin/env node
// Status Stop hook for Claude Code: blocks a session from finishing when it
// changed files inside a tracked project (one with a .project-status.json)
// without updating that project's status file. This turns "agents update the
// board when they finish" from a convention into a guarantee.
//
// Projects are derived from the WRITTEN FILE PATHS (walk up from each written
// file), so a session started anywhere that edits a tracked project by
// absolute path is still enforced. Sessions that wrote nothing, or only wrote
// outside tracked projects, never see a nudge.
//
// Design: strict (blocks, not just reminds) + dirty-board (only fires when
// project files actually changed) + single-nudge (at most one block per stop,
// via the stop_hook_active flag) + fail-open (any error exits 0 silently).
// Zero dependencies, zero model tokens on quiet turns.
//
// Install and details: docs/enforcement.md

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const STATUS_BASENAME = '.project-status.json';
const MAX_WALK_UP = 12;

// Split-layout mapping: a write under <base>/<from>/<name>/ may belong to a
// project whose status file lives at <base>/<to>/<name>/.project-status.json.
// Off by default (the dashboard's model keeps the status file in the project
// folder). Enable with DASHBOARD_STATUS_HOOK_MAP="from/segs:to/segs", e.g.
// "Workspace/Repos:Documents/Projects" for a code/context split layout.
const DEFAULT_MAP = null;
const MAP = parseMap(process.env.DASHBOARD_STATUS_HOOK_MAP) || DEFAULT_MAP;

function parseMap(raw) {
  if (typeof raw !== 'string' || !raw.includes(':')) return null;
  const [from, to] = raw.split(':');
  if (!from || !to) return null;
  return [from.split('/').join(sep), to.split('/').join(sep)];
}

// Find the status file governing a directory: walk up looking for
// .project-status.json, then try the split-layout counterpart. Returns the
// status file path or null. Results memoized per start dir.
function findStatusFor(startDir, cache) {
  const start = resolve(startDir);
  if (cache.has(start)) return cache.get(start);
  const home = homedir();
  let result = null;
  let dir = start;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (existsSync(join(dir, STATUS_BASENAME))) {
      result = join(dir, STATUS_BASENAME);
      break;
    }
    if (dir === home || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  if (!result && MAP) {
    for (const [from, to] of [[MAP[0], MAP[1]], [MAP[1], MAP[0]]]) {
      const m = mapCounterpart(start, from, to);
      if (m && existsSync(join(m.other, STATUS_BASENAME))) {
        result = join(m.other, STATUS_BASENAME);
        break;
      }
    }
  }
  cache.set(start, result);
  return result;
}

function mapCounterpart(path, fromSegs, toSegs) {
  const marker = sep + fromSegs + sep;
  const idx = path.indexOf(marker);
  if (idx === -1) return null;
  const base = path.slice(0, idx);
  const name = path.slice(idx + marker.length).split(sep)[0];
  if (!name) return null;
  return {
    self: join(base, fromSegs, name),
    other: join(base, toSegs, name),
  };
}

function collectWrites(transcriptPath) {
  const writes = [];
  if (typeof transcriptPath !== 'string') return writes;
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return writes; }
  for (const line of raw.split('\n')) {
    if (!line.includes('tool_use')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry && entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item && item.type === 'tool_use' && WRITE_TOOLS.has(item.name)) {
        const p = item.input && (item.input.file_path || item.input.notebook_path);
        if (typeof p === 'string') writes.push(resolve(p));
      }
    }
  }
  return writes;
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  if (!input || input.stop_hook_active) return; // single-nudge: never re-block

  const writes = collectWrites(input.transcript_path);
  if (writes.length === 0) return; // read-only session

  const statusWrites = new Set(writes.filter((p) => p.endsWith(sep + STATUS_BASENAME)));
  const cache = new Map();
  const stale = new Map(); // status file path -> count of unaccounted writes
  for (const p of writes) {
    if (p.endsWith(sep + STATUS_BASENAME)) continue;
    const statusPath = findStatusFor(dirname(p), cache);
    if (!statusPath || statusWrites.has(statusPath)) continue; // untracked or board fresh
    stale.set(statusPath, (stale.get(statusPath) || 0) + 1);
  }
  if (stale.size === 0) return;

  const total = [...stale.values()].reduce((a, b) => a + b, 0);
  const files = [...stale.keys()].join(' and ');
  const reason =
    `This session changed ${total} file(s) in tracked project(s) but did not update ` +
    `the project status file. Update ${files} now: refresh updatedAt (UTC ISO), keep ` +
    `nextAction concrete, adjust progress and milestones if they moved. Then finish. ` +
    `(One-time nudge; status Stop hook.)`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

try { main(); } catch { /* fail open */ }
process.exit(0);
