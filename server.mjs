import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeProjectStatusFile, syncProjects } from "./lib/project-sync.mjs";
import { getLastRun, runAutomation, setAutomationStatus } from "./lib/automation-actions.mjs";
import { dismissSuggestion, startSuggestion } from "./lib/next-projects.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const CONFIG_PATH = path.join(__dirname, "data", "dashboard.config.json");
const NEXT_PROJECTS_PATH = path.join(__dirname, "data", "next-projects.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// The dashboard ships with no authentication and exposes local paths, repo
// URLs, and an endpoint that spawns agent runs, so it is only safe on the
// loopback interface. A non-loopback bind must be opted into explicitly and
// fronted by an authenticating proxy (see README "Exposing the dashboard").
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const BIND_IS_LOOPBACK = LOOPBACK_HOSTS.has(HOST);
const ALLOW_REMOTE_BIND = process.env.DASHBOARD_ALLOW_REMOTE === "1";

// Host header values this server answers to. This is the DNS-rebinding guard:
// a hostile page that repoints its own hostname at 127.0.0.1 still sends its
// own Host header, which is not on this list. Extra names (a reverse proxy or
// tunnel domain) are added via DASHBOARD_ALLOWED_HOSTS (comma-separated).
const ALLOWED_HOSTS = (() => {
  const hosts = new Set();
  for (const name of ["localhost", "127.0.0.1", "[::1]", HOST]) {
    hosts.add(name.toLowerCase());
    hosts.add(`${name}:${PORT}`.toLowerCase());
  }
  for (const extra of (process.env.DASHBOARD_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    hosts.add(extra.toLowerCase());
  }
  return hosts;
})();

function isAllowedHost(hostHeader) {
  return Boolean(hostHeader) && ALLOWED_HOSTS.has(String(hostHeader).toLowerCase());
}

// Returns an error message if a mutating request should be rejected, else null.
// Browsers always attach an Origin on cross-origin writes, so an Origin that is
// not same-origin is a CSRF attempt. A missing Origin only comes from
// non-browser clients (curl, scripts) and is trusted only on a loopback bind.
function writeRejectionReason(req) {
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {
      // Malformed Origin is rejected below.
    }
    return isAllowedHost(host) ? null : "Cross-origin write rejected";
  }
  return BIND_IS_LOOPBACK ? null : "Write requires a same-origin request";
}

// Discovery + git enrichment spawn many subprocesses; cache so the 30s
// frontend poll does not rescan every source root on each request.
const PROJECTS_CACHE_TTL_MS = 60000;
let projectsCache = { at: 0, promise: null };

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, body, type = "text/plain; charset=utf-8", headers = {}) {
  res.writeHead(statusCode, { "content-type": type, ...headers });
  res.end(body);
}

function execGit(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 2500 }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          message: stderr.trim() || error.message
        });
        return;
      }
      resolve({ ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function pathExists(localPath) {
  if (!localPath) return false;
  try {
    await access(localPath);
    return true;
  } catch {
    return false;
  }
}

// A missing or unreadable config behaves as an empty dashboard so a fresh
// clone (data/ is gitignored) serves live checks without a 500.
async function readConfig() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return { projects: [] };
  }
  const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
  return {
    ...parsed,
    projects: await Promise.all(projects.map((project) => mergeProjectStatusFile(project)))
  };
}

async function getGitMeta(localPath) {
  if (!localPath || !(await pathExists(localPath))) {
    return { available: false, reason: "Local path not found" };
  }

  const inside = await execGit(["-C", localPath, "rev-parse", "--is-inside-work-tree"], __dirname);
  if (!inside.ok || inside.stdout !== "true") {
    return { available: false, reason: "Not a git repository" };
  }

  const [branch, statusResult, lastCommit, remote] = await Promise.all([
    execGit(["-C", localPath, "branch", "--show-current"], __dirname),
    execGit(["-C", localPath, "status", "--porcelain=v1"], __dirname),
    execGit(["-C", localPath, "log", "-1", "--format=%cI%x00%h%x00%s%x00%an"], __dirname),
    execGit(["-C", localPath, "remote", "get-url", "origin"], __dirname)
  ]);

  const commitParts = lastCommit.ok && lastCommit.stdout
    ? lastCommit.stdout.split("\u0000")
    : [];

  return {
    available: true,
    branch: branch.ok ? branch.stdout || "detached" : "unknown",
    dirty: statusResult.ok ? statusResult.stdout.length > 0 : null,
    changedFiles: statusResult.ok && statusResult.stdout ? statusResult.stdout.split("\n").length : 0,
    lastCommit: commitParts.length >= 4
      ? {
          date: commitParts[0],
          hash: commitParts[1],
          subject: commitParts[2],
          author: commitParts[3]
        }
      : null,
    remoteUrl: remote.ok ? remote.stdout : null
  };
}

function normalizeHealthStatus(statusCode) {
  if (!statusCode) return "Unknown";
  if (statusCode >= 200 && statusCode < 300) return "Live";
  if (statusCode >= 300 && statusCode < 400) return "Redirecting";
  if (statusCode === 401 || statusCode === 403) return "Auth required";
  return "Down";
}

function checkHealth(targetUrl) {
  return new Promise((resolve) => {
    let settled = false;
    let deadline = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(result);
    };

    if (!targetUrl) {
      finish({
        status: "Unknown",
        checkedAt: new Date().toISOString(),
        responseTimeMs: null,
        statusCode: null,
        error: "No liveUrl or healthCheckUrl configured"
      });
      return;
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      finish({
        status: "Unknown",
        checkedAt: new Date().toISOString(),
        responseTimeMs: null,
        statusCode: null,
        error: "Invalid URL"
      });
      return;
    }

    const startedAt = Date.now();
    const transport = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = transport(
      parsed,
      {
        method: "GET",
        timeout: 5000,
        // mDNS hosts resolve to a link-local IPv6 address first, which Node
        // intermittently fails to connect to; LAN devices serve over IPv4.
        family: parsed.hostname.endsWith(".local") ? 4 : undefined,
        headers: {
          "user-agent": "AviProjectDashboard/0.1"
        }
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          finish({
            status: normalizeHealthStatus(response.statusCode),
            checkedAt: new Date().toISOString(),
            responseTimeMs: Date.now() - startedAt,
            statusCode: response.statusCode,
            location: response.headers.location || null,
            url: targetUrl
          });
        });
      }
    );

    // The socket timeout only fires on inactivity; a slow-drip response would
    // keep the request alive forever, so enforce a hard overall deadline too.
    deadline = setTimeout(() => {
      req.destroy(new Error("Health check exceeded 7s deadline"));
    }, 7000);

    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });

    req.on("error", (error) => {
      finish({
        status: "Down",
        checkedAt: new Date().toISOString(),
        responseTimeMs: Date.now() - startedAt,
        statusCode: null,
        error: error.message,
        url: targetUrl
      });
    });

    req.end();
  });
}

async function enrichProject(project) {
  const localPathFound = await pathExists(project.localPath);
  const stats = localPathFound ? await stat(project.localPath).catch(() => null) : null;
  const gitPath = project.repoPath || project.localPath;
  const git = await getGitMeta(gitPath);

  return {
    ...project,
    localPathFound,
    localPathType: stats?.isDirectory() ? "directory" : stats?.isFile() ? "file" : null,
    gitPath,
    git,
    health: null
  };
}

async function loadEnrichedProjects() {
  const syncResult = await syncProjects({ write: false });
  const projects = await Promise.all(syncResult.projects.map((project) => enrichProject(project)));
  return { syncedAt: syncResult.generatedAt, projects };
}

function getEnrichedProjects() {
  const fresh = projectsCache.promise && Date.now() - projectsCache.at < PROJECTS_CACHE_TTL_MS;
  if (fresh) return projectsCache.promise;

  const promise = loadEnrichedProjects();
  promise.catch(() => {
    if (projectsCache.promise === promise) {
      projectsCache = { at: 0, promise: null };
    }
  });
  projectsCache = { at: Date.now(), promise };
  return promise;
}

function invalidateProjectsCache() {
  projectsCache = { at: 0, promise: null };
}

async function handleApi(req, res, requestUrl) {
  // Mutating routes are same-origin only. The Origin is checked against a
  // fixed host allowlist (not the request's own Host header), so a
  // DNS-rebinding page cannot make itself look same-origin.
  if (req.method !== "GET") {
    const rejection = writeRejectionReason(req);
    if (rejection) {
      sendJson(res, 403, { error: rejection });
      return;
    }
  }

  if (requestUrl.pathname === "/api/sync") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Use POST for sync" });
      return;
    }

    const result = await syncProjects({ write: true });
    invalidateProjectsCache();
    sendJson(res, 200, result);
    return;
  }

  if (requestUrl.pathname === "/api/projects") {
    // Read-only: config writes happen only via POST /api/sync or the CLI,
    // so the frontend's periodic polling never rewrites dashboard.config.json.
    const includeGit = requestUrl.searchParams.get("git") !== "0";
    const includeHealth = requestUrl.searchParams.get("health") === "1";
    const cached = await getEnrichedProjects();
    let projects = includeGit
      ? cached.projects
      : cached.projects.map((project) => ({ ...project, git: null }));
    if (includeHealth) {
      projects = await Promise.all(projects.map(async (project) => {
        const target = project.healthCheckUrl || project.liveUrl;
        return target ? { ...project, health: await checkHealth(target) } : project;
      }));
    }
    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      schemaVersion: 1,
      syncedAt: cached.syncedAt,
      projects
    });
    return;
  }

  if (requestUrl.pathname === "/api/health") {
    const config = await readConfig();
    const onlineProjects = config.projects.filter((project) => project.liveUrl || project.healthCheckUrl);
    const health = await Promise.all(
      onlineProjects.map(async (project) => ({
        id: project.id,
        name: project.name,
        ...(await checkHealth(project.healthCheckUrl || project.liveUrl))
      }))
    );
    sendJson(res, 200, { generatedAt: new Date().toISOString(), health });
    return;
  }

  if (requestUrl.pathname === "/api/next-projects") {
    // Missing file on a fresh clone (data/ is gitignored) is an empty list,
    // not a 500.
    let payload = { suggestions: [] };
    try {
      payload = JSON.parse(await readFile(NEXT_PROJECTS_PATH, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    sendJson(res, 200, payload);
    return;
  }

  // What's next suggestion actions. Like the automation routes, the id is
  // only matched against entries in data/next-projects.json; it never reaches
  // the filesystem directly (start derives the folder name from the matched
  // suggestion's title, not from the request).
  const nextProjectMatch = requestUrl.pathname.match(/^\/api\/next-projects\/([A-Za-z0-9._-]+)\/(dismiss|start)$/);
  if (nextProjectMatch) {
    const [, suggestionId, action] = nextProjectMatch;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: `Use POST for ${action}` });
      return;
    }

    if (action === "dismiss") {
      const result = await dismissSuggestion(suggestionId);
      if (!result) {
        sendJson(res, 404, { error: `Unknown suggestion: ${suggestionId}` });
        return;
      }
      sendJson(res, 200, { ok: true, suggestion: result.suggestion });
      return;
    }

    try {
      const result = await startSuggestion(suggestionId);
      if (!result) {
        sendJson(res, 404, { error: `Unknown suggestion: ${suggestionId}` });
        return;
      }
      // Sync so the new project home appears on the Tracked board right away.
      await syncProjects({ write: true });
      invalidateProjectsCache();
      sendJson(res, 200, { ok: true, suggestion: result.suggestion, projectPath: result.projectPath });
    } catch (error) {
      if (error.code === "EEXISTS") {
        sendJson(res, 409, { error: error.message });
        return;
      }
      if (error.code === "NO_ROOT" || error.code === "NO_SLUG") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  // Scheduled card actions. The id is only ever matched against automations
  // discovered on disk; it never reaches the filesystem or a shell. The
  // optional runner hint disambiguates a Codex automation and a Claude task
  // that happen to share an id.
  const automationMatch = requestUrl.pathname.match(/^\/api\/automations\/([A-Za-z0-9._-]+)\/(pause|resume|run|last-run)$/);
  if (automationMatch) {
    const [, automationId, action] = automationMatch;
    const runner = requestUrl.searchParams.get("runner");

    if (action === "last-run") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Use GET for last-run" });
        return;
      }
      const result = await getLastRun(automationId, runner);
      if (!result) {
        sendJson(res, 404, { error: `Unknown automation: ${automationId}` });
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: `Use POST for ${action}` });
      return;
    }

    if (action === "run") {
      try {
        const result = await runAutomation(automationId, runner);
        if (!result) {
          sendJson(res, 404, { error: `Unknown automation: ${automationId}` });
          return;
        }
        sendJson(res, 202, result);
      } catch (error) {
        if (error.code === "RUN_ACTIVE") {
          sendJson(res, 409, { error: error.message });
          return;
        }
        if (error.code === "NO_CODEX" || error.code === "NO_CLAUDE" || error.code === "NO_PROMPT") {
          sendJson(res, 503, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    const result = await setAutomationStatus(automationId, action, runner);
    if (!result) {
      sendJson(res, 404, { error: `Unknown automation: ${automationId}` });
      return;
    }
    invalidateProjectsCache();
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "Unknown API route" });
}

async function serveStatic(req, res, requestUrl) {
  const requested = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const decodedPath = decodeURIComponent(requested);
  const filePath = path.normalize(path.join(PUBLIC_DIR, decodedPath));

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    const type = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    sendText(res, 200, body, type, { "cache-control": "no-store" });
  } catch {
    sendText(res, 404, "Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    // DNS-rebinding guard: reject any request whose Host header is not one this
    // server was told to answer to, before it can read data or trigger a run.
    if (!isAllowedHost(req.headers.host)) {
      sendJson(res, 403, { error: "Host not allowed" });
      return;
    }
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(req, res, requestUrl);
      return;
    }
    await serveStatic(req, res, requestUrl);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 500, { error: error.message });
  }
});

server.on("error", (error) => {
  console.error(`Project dashboard failed to start: ${error.message}`);
  process.exitCode = 1;
});

if (!BIND_IS_LOOPBACK && !ALLOW_REMOTE_BIND) {
  console.error(
    `Refusing to bind ${HOST}: the dashboard has no built-in authentication and would expose local paths and an agent-run trigger to the network.\n` +
    "Keep HOST on 127.0.0.1, or put an authenticating proxy in front and set DASHBOARD_ALLOW_REMOTE=1 (add the public hostname to DASHBOARD_ALLOWED_HOSTS)."
  );
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  if (!BIND_IS_LOOPBACK) {
    console.warn(`Warning: binding ${HOST} exposes the dashboard beyond this machine. Ensure an authenticating proxy sits in front of it.`);
  }
  console.log(`Project dashboard running at http://${HOST}:${PORT}`);
});
