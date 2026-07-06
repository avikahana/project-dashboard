# Projects Dashboard

A local dashboard for tracking active projects, completed projects, local folders, repos, and online health.

## Run

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:4173
```

The app has no third-party package dependencies. It uses Node's built-in HTTP server, Git CLI metadata, and a static frontend.

## Sync Projects

The dashboard discovers projects from configured roots and merges them into:

```text
data/dashboard.config.json
```

Run a manual sync with:

```bash
npm run sync
```

Preview a sync without writing:

```bash
npm run sync:dry-run
```

The dashboard also runs sync before serving `/api/projects`, so normal page loads pick up status changes written by Claude or Codex. The open page quietly reloads project data while visible, reloads when the tab regains focus, and the **Refresh** button still runs sync explicitly before reloading project data.

Duplicate retained records that point at the same `statusFile` or `localPath` are collapsed during sync.

Codex scheduled tasks are also discovered from:

```text
$CODEX_HOME/automations/*/automation.toml
```

Each automation becomes its own card under the Scheduled group, using the real automation name, status, recurrence rule, target workspace, model, and prompt. These cards are read-only reflections of Codex automation state; edit the automation itself to change the card.

Next-project suggestions live in:

```text
data/next-projects.json
```

Each suggestion becomes its own card in the What's Next section after the project list. These are idea cards, not tracked projects, so they do not affect active, completed, scheduled, online, or review counts.

Configured source roots live in:

```text
data/dashboard.sources.json
```

This file is machine-specific and gitignored; without it no roots are scanned. Create it with the folders the dashboard should discover projects in:

```json
{
  "sources": [
    {
      "id": "projects-home",
      "label": "Projects",
      "type": "local",
      "rootPath": "/absolute/path/to/your/projects"
    }
  ]
}
```

## Project Source Of Truth

`data/dashboard.config.json` is only the dashboard index. It is generated/merged from:

- discovered Claude/Codex project folders
- local git metadata
- each project's `.project-status.json`
- Codex automation files under `$CODEX_HOME/automations`
- existing dashboard index entries that are outside the scanned roots

For real project status, add this file inside each project root:

```text
.project-status.json
```

Use specific names when one product has multiple homes. For example, use `Token Optimizer Product Repo` and `Token Optimizer Brain` instead of naming both folders `Token Optimizer`.

Moving a card between dashboard groups is controlled by the exact `status` value in that file. Use only `planning`, `active`, `building`, `blocked`, `paused`, `maintenance`, or `completed`.

Example:

```json
{
  "name": "Project name",
  "status": "active",
  "type": "codex",
  "repoUrl": "https://github.com/example/repo",
  "liveUrl": "https://example.com",
  "healthCheckUrl": "https://example.com/health",
  "progress": 65,
  "phase": "building",
  "confidence": "medium",
  "nextAction": "Verify the booking flow",
  "notes": "Short context for the project.",
  "completedAt": null,
  "updatedAt": "2026-07-01",
  "tags": ["dashboard", "local"],
  "milestones": [
    { "name": "Core UI", "done": true },
    { "name": "Live status checks", "done": false }
  ]
}
```

## Progress Model

Progress is intentionally hybrid:

- `progress` is a manual 0-100 estimate and should be treated as the source of truth.
- `milestones` explain the progress number.
- Git metadata and live checks are supporting evidence only.
- Do not infer fake progress from commit count, file count, or recent activity.
- Use `null` for unknown progress.
- Use `100` only when `status` is `completed`, `phase` is `shipped`, and `completedAt` is set.

Use these agent-writable status values:

- `planning`: not implemented yet, but intentionally tracked
- `active`: currently alive or being actively considered
- `building`: implementation, testing, or other hands-on construction work
- `blocked`: waiting on something
- `paused`: intentionally not active
- `maintenance`: shipped but still alive
- `completed`: done and shown in completed projects

`scheduled` is a dashboard group derived from Codex automation files; agents should not write `status: "scheduled"` in project status files.

Do not use natural-language aliases such as `done`, `working`, `testing`, `in progress`, or `on hold` in source files. The dashboard normalizes common aliases defensively:

- `done`, `finished`, `shipped` -> `completed`
- `idea`, `backlog`, `planned` -> `planning`
- `building`, `testing`, `implementing`, `coding` -> `building`
- `working`, `in progress`, `activated` -> `active`
- `live` -> `maintenance`
- `hold`, `on hold`, `deferred` -> `paused`

If an agent writes an unrecognized status, the sync layer normalizes it to `active` and marks the generated dashboard record with `needs-review` and `status-normalized` tags. That prevents accidental new dashboard groups while still making the uncertainty visible.

Use these phase values:

- `idea`
- `planning`
- `building`
- `testing`
- `shipped`
- `maintenance`
- `paused`

Use these confidence values:

- `high`
- `medium`
- `low`

## Live Checks

Projects with `liveUrl` or `healthCheckUrl` can be checked from the local server. The UI reports:

- `Live`
- `Down`
- `Redirecting`
- `Auth required`
- `Unknown`

Live health is separate from project progress. A shipped site can be down, and an unfinished project can still have a live preview.

## Local Links

Browsers usually block direct opening of local folders from a webpage. The dashboard therefore shows copyable absolute paths. Repo and live links open normally when configured.
