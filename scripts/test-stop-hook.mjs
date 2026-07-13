#!/usr/bin/env node
// Self-contained test for hooks/status-stop-hook.mjs. Builds its own fixture
// tree in a temp directory, feeds the hook each scenario over stdin, and
// checks the block/silent outcome. No dependencies. Exit 0 = all pass.
//
// Run: node scripts/test-stop-hook.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'status-stop-hook.mjs');
const root = mkdtempSync(join(tmpdir(), 'stop-hook-test-'));

// Fixture layout: one plain tracked project (status file in the project
// folder, the dashboard's default model) and one split-layout pair for the
// DASHBOARD_STATUS_HOOK_MAP scenario.
const plain = join(root, 'projects', 'demo');
const splitCode = join(root, 'code', 'demo2');
const splitCtx = join(root, 'ctx', 'demo2');
const untracked = join(root, 'scratch');
for (const d of [plain, splitCode, splitCtx, untracked]) mkdirSync(d, { recursive: true });
writeFileSync(join(plain, '.project-status.json'), '{"status":"active"}\n');
writeFileSync(join(splitCtx, '.project-status.json'), '{"status":"active"}\n');

function transcript(name, writes) {
  const lines = writes.map(([tool, file]) =>
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: tool, input: { file_path: file } }] } }));
  const p = join(root, name + '.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

const tEditPlain = transcript('edit-plain', [['Edit', join(plain, 'server.mjs')]]);
const tEditPlusStatus = transcript('edit-plus-status', [
  ['Edit', join(plain, 'server.mjs')],
  ['Write', join(plain, '.project-status.json')],
]);
const tEditUntracked = transcript('edit-untracked', [['Write', join(untracked, 'notes.md')]]);
const tEditSplit = transcript('edit-split', [['Edit', join(splitCode, 'app.js')]]);

const scenarios = [
  {
    name: 'project edit without status write -> block',
    stdin: { cwd: plain, transcript_path: tEditPlain, stop_hook_active: false },
    expect: 'block',
  },
  {
    name: 'stop_hook_active -> silent (single-nudge)',
    stdin: { cwd: plain, transcript_path: tEditPlain, stop_hook_active: true },
    expect: 'silent',
  },
  {
    name: 'status file written this session -> silent',
    stdin: { cwd: plain, transcript_path: tEditPlusStatus, stop_hook_active: false },
    expect: 'silent',
  },
  {
    name: 'writes only outside tracked projects -> silent',
    stdin: { cwd: untracked, transcript_path: tEditUntracked, stop_hook_active: false },
    expect: 'silent',
  },
  {
    name: 'read-only session (missing transcript) -> silent',
    stdin: { cwd: plain, transcript_path: join(root, 'nope.jsonl'), stop_hook_active: false },
    expect: 'silent',
  },
  {
    name: 'garbage stdin -> silent (fail-open)',
    raw: 'not json at all',
    expect: 'silent',
  },
  {
    name: 'generic cwd, project edited by absolute path -> block',
    stdin: { cwd: untracked, transcript_path: tEditPlain, stop_hook_active: false },
    expect: 'block',
  },
  {
    name: 'split layout without mapping -> silent (untracked)',
    stdin: { cwd: untracked, transcript_path: tEditSplit, stop_hook_active: false },
    expect: 'silent',
  },
  {
    name: 'split layout with DASHBOARD_STATUS_HOOK_MAP -> block',
    stdin: { cwd: untracked, transcript_path: tEditSplit, stop_hook_active: false },
    env: { DASHBOARD_STATUS_HOOK_MAP: 'code:ctx' },
    expect: 'block',
  },
];

let failed = 0;
for (const s of scenarios) {
  const input = s.raw ?? JSON.stringify(s.stdin);
  const res = spawnSync('node', [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, DASHBOARD_STATUS_HOOK_MAP: '', ...s.env },
  });
  const out = (res.stdout || '').trim();
  const blocked = out.includes('"decision":"block"');
  const ok = res.status === 0 && (s.expect === 'block' ? blocked : out === '');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.name}${ok ? '' : `  (exit ${res.status}, out: ${out || '<empty>'})`}`);
  if (!ok) failed++;
}

rmSync(root, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed} scenario(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${scenarios.length} scenarios pass`);
