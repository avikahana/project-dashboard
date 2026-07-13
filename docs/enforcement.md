# Enforcement: the status Stop hook (optional)

The dashboard is only as truthful as the `.project-status.json` files it reads. If your
agents update those files by convention ("always update the status file when you finish"),
the board drifts whenever a session forgets, gets interrupted, or ends early. This optional
Claude Code Stop hook turns the convention into a guarantee: **a session that changed files
inside a tracked project cannot finish until it updates that project's status file.**

Codex has no hook system, so Codex sessions stay on whatever standing instruction you give
them (for example in `AGENTS.md`). This hook covers Claude Code only.

## How it decides

The hook is a plain local Node script (`hooks/status-stop-hook.mjs`, zero dependencies)
that Claude Code runs every time a session tries to finish. It costs zero model tokens on
turns where there is nothing to fix. In order:

1. If this stop is already a hook retry (`stop_hook_active`), stay silent — at most one
   nudge per stop, never a loop.
2. Collect every file the session wrote (`Write` / `Edit` / `MultiEdit` / `NotebookEdit`
   calls in the transcript). No writes → silent.
3. For each written file, walk up from the file's directory (up to 12 levels, stopping at
   `$HOME`) looking for a `.project-status.json`. Files with no status file above them
   (scratch work, temp dirs) are ignored. Because detection follows the **written file
   paths**, not the session's working directory, a session started anywhere that edits a
   tracked project by absolute path is still enforced.
4. A project whose status file was itself written this session is fresh → silent for that
   project.
5. If any tracked project has changes but no status update, emit one block telling the
   agent exactly which status file to update (refresh `updatedAt`, keep `nextAction`
   concrete, adjust `progress`/`milestones`). The agent updates it, then finishes.

Fail-open by design: any error inside the script exits 0 silently. The worst failure mode
is "back to convention", never "session stuck".

## Split layouts

If you keep code and project context in sibling trees (for example
`.../Workspace/Repos/<name>/` for code and `.../Documents/Projects/<name>/` for context,
with the status file on the context side), set:

```bash
DASHBOARD_STATUS_HOOK_MAP="Workspace/Repos:Documents/Projects"
```

A write under either side then satisfies (or dirties) the same project. Unset by default.

## Install

1. Copy the script somewhere stable:

   ```bash
   mkdir -p ~/.claude/hooks
   cp hooks/status-stop-hook.mjs ~/.claude/hooks/
   ```

2. Merge the `Stop` entry from `hooks/settings-snippet.json` into the `hooks` object of
   `~/.claude/settings.json` (append to an existing `Stop` array rather than replacing it).

3. Hooks are snapshotted at session start, so the hook applies to sessions started after
   the install. To verify: in a new session inside a tracked project, ask for one trivial
   file edit and tell the agent not to touch anything else. The agent should get blocked
   once, update the status file, then finish. A read-only follow-up turn should end with
   no nudge.

Rollback: remove the `Stop` entry from `~/.claude/settings.json`. The script file is inert
unless registered.

## Cost

The decision logic runs locally and spends no model tokens. Tokens are spent only when a
block actually lands: one short read-edit-confirm sequence, typically a few cents on large
models (scaling with how deep the session context already is) — for a status update you
wanted anyway. Sessions that touch no tracked project never pay.

## Test

```bash
node scripts/test-stop-hook.mjs
```

Runs a 9-scenario matrix (block on dirty project, silent on re-nudge / fresh board /
untracked writes / read-only sessions / malformed input, absolute-path detection, and the
split-layout mapping) against fixtures in a temp directory. Exit 0 means all pass.
