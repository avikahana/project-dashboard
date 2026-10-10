# Projects Dashboard

A local dashboard for tracking AI bot workstreams, project folders, repos, and online health.

![Projects Dashboard board view](docs/screenshot-dashboard.png)

Each project expands into a full card with progress, next action, milestones, and git evidence:

![Expanded project card](docs/screenshot-project-card.png)

## Run

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:4173
```

The app has no third-party package dependencies. It uses Node's built-in HTTP server, Git CLI metadata, and a static frontend.

### First run

`data/` is machine-specific and gitignored, so a fresh clone starts empty: no projects, no suggestions. That is expected. To populate the dashboard, create `data/dashboard.sources.json` (see Sync Projects below) and press **Refresh projects**, or run `npm run sync`.

## Layout

The page base, visible on every tab, is the metric strip (Ongoing, Planning, Completed, Online, Needs review) with the Online strip directly under it. Below that, a left rail switches between five views:

- **Tracked projects**: the grouped project list. Projects with a `bot` field are grouped into one section per bot (section title = bot name), each listing that bot's ongoing workstreams with their status visible on each row (active vs blocked/waiting on Avi). Projects without a `bot` field fall back to the existing status grouping (pinned, active, planning, paused, blocked, completed, private). Status filters, search, and sorting are available. Each row expands into the full project card. The row menu's **Move to** submenu moves a card to another status group by rewriting the `status` field in that project's own `.project-status.json` on disk (moving to Completed stamps `completedAt`, moving out clears it); its **Private** target changes no status files; the hidden list is saved server-side in `data/dashboard.prefs.json` (gitignored) so it holds across browsers and hostnames, while Pin stays browser-local. Group targets appear only on cards that have a status file.
- **What's next**: idea rows from `data/next-projects.json`. These are suggestions, not tracked projects, and do not affect any counts. Each row has two actions: **Dismiss** hides the suggestion (its `status` flips to `dismissed` in the file; restore by editing the file), and **Start** promotes it, creating a new project home folder containing a planning `.project-status.json` and syncing it onto the Tracked board. Start writes a real folder on this machine, under `DASHBOARD_NEW_PROJECT_ROOT` if set, otherwise the first root in `data/dashboard.sources.json`.
- **Online**: one expandable row per project with a `liveUrl` or `healthCheckUrl`, showing the full latest health result.
- **Checklists**: two lists. **Projects Next Steps** is built from each card's `nextAction`; its check state is browser-local only and never edits the project's own files. Below it, a standalone checklist (currently the Knowledge Expanders learning list) is served from `data/checklist.json`; checking an item persists `done`/`doneAt` into that file via `POST /api/checklist/:id/check|uncheck`, so its state holds across browsers. The file is machine-specific and gitignored; if it is missing the group simply does not appear.
- **Waiting PRs**: open pull requests across every tracked project's GitHub remote, fetched via the `gh` CLI (must be installed and authenticated; non-GitHub remotes are skipped). Each card shows check status (Failed/Pending/Success/Draft), the review decision when there is one, branch, author, relative age, and a **Go to PR** link. The rail tab carries a red count pill visible from every view, refreshed every minute. `GET /api/waiting-prs` caches results server-side for a minute; a repo `gh` cannot reach becomes a note under the list instead of failing the view, and a missing `gh` binary just shows a hint.

## Bot Entries

Each bot in the team has multiple project entries (workstreams) in `data/dashboard.config.json`. A bot entry carries:

- `source`: `"bots-board"`
- `type`: `"bot"`
- `tags`: includes a tag like `"bot-dalek"`
- `bot`: an object with `name` (the bot's display name, used as the section title), `domain` (its area of responsibility), and `waitingOn` (who or what it is blocked on, or `null` if active)
- `status`: `"active"` or `"blocked"`
- `progress`: `null` (bot entries do not track a numeric progress percentage)

Bot entries with `progress: null` do **not** count toward the Needs review metric or receive a "Review needed" badge — unlike non-bot entries, where `null` progress is treated as uncertain data.

Example bot entry in `data/dashboard.config.json`:

```json
{
  "id": "bot-walle-files",
  "name": "WALL-E - Files and folders structure",
  "source": "bots-board",
  "type": "bot",
  "status": "active",
  "progress": null,
  "tags": ["bot-walle"],
  "bot": {
    "name": "WALL-E",
    "domain": "File organisation",
    "waitingOn": null
  },
  "nextAction": "Finish folder reorganisation plan",
  "milestones": [
    { "name": "Audit current layout", "done": true },
    { "name": "Propose new structure", "done": false }
  ]
}
```

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

The dashboard also runs sync before serving `/api/projects`, so normal page loads pick up status changes. The open page quietly reloads project data while visible, reloads when the tab regains focus, and the **Refresh** button still runs sync explicitly before reloading project data.

Duplicate retained records that point at the same `statusFile` or `localPath` are collapsed during sync.

Next-project suggestions live in:

```text
data/next-projects.json
```

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

## Enforcement (Optional)

The board stays truthful only if agents actually update `.project-status.json` when they
finish working. `hooks/status-stop-hook.mjs` is an optional Claude Code Stop hook that
makes this structural instead of conventional: a session that changed files inside a
tracked project is blocked from finishing until it updates that project's status file.
One nudge per stop, silent on sessions that touched no tracked project, fail-open on any
error, zero dependencies, zero model tokens except when a block lands. Install, split-layout
config, and the test suite (`node scripts/test-stop-hook.mjs`) are documented in
[docs/enforcement.md](docs/enforcement.md).

## Security Model

This dashboard has no built-in authentication and its API exposes local absolute paths, git remotes, and notes. It is designed to be reachable from this machine only:

- The server binds `127.0.0.1` by default and refuses to start on a non-loopback `HOST` unless `DASHBOARD_ALLOW_REMOTE=1` is set explicitly.
- Every request's `Host` header is checked against a fixed allowlist (a DNS-rebinding guard). A reverse proxy or tunnel hostname must be added via `DASHBOARD_ALLOWED_HOSTS` (comma-separated).
- Mutating requests are same-origin only; cross-origin writes are rejected against the same fixed allowlist, not the request's own headers.

If you want the dashboard reachable from anywhere, do not expose the port directly. Put an authenticating proxy in front of it (for example a Cloudflare Tunnel with Access, or a reverse proxy with SSO), keep the server itself on loopback, and add the public hostname to `DASHBOARD_ALLOWED_HOSTS`.

## Project Source Of Truth

`data/dashboard.config.json` is only the dashboard index. It is generated/merged from:

- discovered project folders
- local git metadata
- each project's `.project-status.json`
- existing dashboard index entries that are outside the scanned roots

For real project status, add this file inside each project root:

```text
.project-status.json
```

Use specific names when one product has multiple homes. For example, use `Token Optimizer Product Repo` and `Token Optimizer Brain` instead of naming both folders `Token Optimizer`.

Moving a card between dashboard groups is controlled by the exact `status` value in that file. Use only `planning`, `active`, `blocked`, `paused`, `maintenance`, or `completed`.

Example:

```json
{
  "name": "Project name",
  "status": "active",
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
- Use `null` for unknown progress. For bot entries, `null` is the expected default.
- Use `100` only when `status` is `completed`, `phase` is `shipped`, and `completedAt` is set.

Use these agent-writable status values:

- `planning`: not implemented yet, but intentionally tracked
- `active`: currently alive, under construction, or being actively considered
- `blocked`: waiting on something
- `paused`: intentionally not active
- `maintenance`: shipped but still alive
- `completed`: done and shown in completed projects

Do not use natural-language aliases such as `done`, `working`, `testing`, `in progress`, or `on hold` in source files. The dashboard normalizes common aliases defensively:

- `done`, `finished`, `shipped` become `completed`
- `idea`, `backlog`, `planned` become `planning`
- `building`, `testing`, `implementing`, `coding`, `working`, `in progress`, `activated` become `active`
- `live` becomes `maintenance`
- `hold`, `on hold`, `deferred` become `paused`

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
