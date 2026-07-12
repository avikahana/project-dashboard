# Projects Dashboard Cookbook

A practical guide to building a local, agent-maintained project dashboard.

This is the companion version I would share with a LinkedIn post: public-safe, implementation-oriented, and stripped of private folder details. It explains the pattern behind the Dashboard more than the exact contents of one personal workspace.

## The Short Version

The Projects Dashboard is a small local web app that answers one recurring question:

> What am I working on, what is done, what is blocked, and what should the next agent session do?

It does that by combining:

- local project discovery
- per-project `.project-status.json` files
- git metadata
- optional live site health checks
- local browser state for pins and private hiding
- a static frontend served by a tiny Node server

The important design choice is that the dashboard is not the source of truth. Each project owns its own status file. The dashboard only reads, merges, and presents that truth.

## Recipe 1: Give Every Project A Status File

Create a `.project-status.json` file in each tracked project root.

```json
{
  "name": "Example Product Repo",
  "status": "building",
  "type": "codex",
  "repoUrl": "https://github.com/example/example-product",
  "liveUrl": null,
  "healthCheckUrl": null,
  "progress": 62,
  "phase": "building",
  "confidence": "medium",
  "nextAction": "Add the import preview screen and verify it with one sample file.",
  "notes": "Local project for testing a new workflow before publishing it.",
  "completedAt": null,
  "updatedAt": "2026-07-01",
  "tags": ["local", "dashboard", "agent-maintained"],
  "milestones": [
    { "name": "Project scaffolded", "done": true },
    { "name": "Core workflow implemented", "done": true },
    { "name": "Preview screen verified", "done": false }
  ]
}
```

The `nextAction` field is the magic part. It turns a dashboard card into a restart point for the next human or AI session.

## Recipe 2: Keep Status Values Boring

Use a tiny status vocabulary:

- `planning`
- `active`
- `building`
- `blocked`
- `paused`
- `maintenance`
- `completed`

That makes grouping predictable. It also keeps agents from inventing one-off statuses like `almost done`, `testing-ish`, or `waiting maybe`.

Use `progress` as a manual estimate, not an inferred number. A commit count is not progress. A file count is not progress. The milestones should explain the percentage.

## Recipe 3: Separate Project Truth From Dashboard State

Project truth belongs in the project:

```text
project-root/.project-status.json
```

Dashboard index data belongs in the dashboard:

```text
data/dashboard.config.json
```

Browser preferences belong in the browser:

```text
localStorage
```

That separation matters. A pinned card or hidden card is a personal viewing preference, not a change to the project itself. A project being completed is real project truth, so it belongs in the status file.

## Recipe 4: Make Sync Boring Too

The dashboard has two basic sync commands:

```bash
npm run sync
```

```bash
npm run sync:dry-run
```

The sync step discovers projects, reads status files, merges existing dashboard records, and writes the generated dashboard index. The dry run is useful before changing a lot of local project folders.

The local server can also sync before serving project data, so the page reflects recent status-file edits without turning the dashboard into a database.

## Recipe 5: Design For The Human Scan

The Dashboard uses grouped, collapsible project cards because the main job is triage:

- What is ongoing?
- What is planning?
- What is blocked?
- What is completed?
- What needs review?
- What is online?

Each card should answer the same questions in the same order:

- name
- status
- progress
- phase
- next action
- notes
- milestones
- repo, local path, and live links when available

Consistency beats cleverness here. The UI should reduce the time it takes to re-enter a project.

## Recipe 6: Add Live Checks Without Confusing Them With Progress

If a project has a public URL or health endpoint, track it separately:

```json
{
  "liveUrl": "https://example.com",
  "healthCheckUrl": "https://example.com/health"
}
```

A live site can still need work. A half-built local tool can still have a healthy preview URL. Keep uptime and project progress as separate signals.

## Recipe 7: Let Agents Maintain The Dashboard

The useful standing instruction is simple:

```text
At the end of a project session, read the project's .project-status.json file,
preserve unrelated fields, update status, phase, progress, confidence,
updatedAt, milestones, and nextAction, then report the exact nextAction.
```

This turns the dashboard into a continuity layer between sessions. The agent does not need to remember everything. It just needs to leave the next session a concrete handle.

## Recipe 8: Make Private Work Shareable By Design

If you want to post about a local dashboard publicly, avoid sharing:

- private absolute paths
- client names
- secret-risk locations
- unfinished sensitive project names
- raw agent handoffs
- local automation prompts that contain private context

Instead, share the pattern:

- project-owned status files
- generated dashboard index
- local-first UI
- manual progress with milestone evidence
- agent-written next actions
- private browser-only preferences

That is the reusable idea. The private project inventory can stay private.

## Recipe 9: Keep A "What's Next" Lane

Not every idea should become a tracked project. The Dashboard keeps next-project suggestions separate from active project cards.

That prevents a common failure mode: turning every idea into fake active work.

A good idea card should include:

- a short title
- why it is interesting
- what the first concrete experiment would be
- whether it needs a repo, research note, or no action yet

## Recipe 10: Treat Run Buttons As Real Agent Launches

If the dashboard mirrors scheduled agent tasks (Codex automations, Claude Code scheduled tasks), a "Run now" button is not a UI refresh. It spawns a real CLI agent process on the host machine with the task's own prompt and working directory.

Design rules that keep this sane:

- Ask for confirmation before every run, and name the runner in the prompt.
- Pin the agent's tool allowlist server-side, so a task prompt cannot escalate to shell access or external connectors.
- Allow one concurrent run per task, with a hard timeout.
- Log every run to a file and show the outcome on the card.
- Keep pause/resume edits surgical: flip only the one field the runner owns, write atomically, and change nothing else in the runner's files.
- Never expose any of this beyond loopback without an authenticating proxy in front.

## Recipe 11: Use The Dashboard As An Operating Ritual

The ritual is the product:

1. Start work from the project card.
2. Do the smallest useful next action.
3. Update the project-owned status file.
4. Run dashboard sync.
5. Check the card.
6. Leave a better `nextAction` than the one you found.

That loop turns many half-remembered local projects into a system you can actually resume.

## Copyable LinkedIn Post

I built a small local Projects Dashboard for my AI-assisted work.

The main idea is simple: the dashboard is not the source of truth. Each project owns a `.project-status.json` file with status, progress, milestones, confidence, and one concrete `nextAction`.

The dashboard just discovers those files, merges them with git metadata and optional live checks, then gives me a local cockpit for ongoing work, planning, blocked projects, completed work, and ideas.

The most useful field is not progress. It is `nextAction`.

When an agent session ends, it updates the project status file and leaves the next session one specific restart point. That tiny discipline makes local projects much easier to resume, especially when work jumps between humans, Claude, Codex, browser tools, repos, and private notes.

The pattern I like:

- project truth lives with the project
- dashboard state is generated
- private UI preferences stay in local browser state
- progress is manual and explained by milestones
- live health is separate from completion
- every session ends by improving the next restart point

It is less about a dashboard and more about making continuity visible.

## Minimal File Map

```text
dashboard/
  server.mjs
  public/
    index.html
    app.js
    styles.css
  lib/
    project-sync.mjs
    claude-tasks.mjs
    automation-actions.mjs
    json-files.mjs
  scripts/
    sync-projects.mjs
  data/
    dashboard.sources.json
    dashboard.config.json
    next-projects.json
  docs/
    projects-dashboard-cookbook.md
```

## Minimal Commands

```bash
npm run dev
npm run sync
npm run sync:dry-run
npm run check
```

## The Takeaway

A dashboard does not need a complex backend to be useful. For a personal AI-assisted workspace, a local app plus durable per-project status files can be enough.

The deeper trick is social, not technical: make every session leave behind a better next step.
