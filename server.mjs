import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { execFile } from "node:child_process";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeProjectStatusFile, syncProjects } from "./lib/project-sync.mjs";
import { getLastRun, runAutomation, setAutomationStatus } from "./lib/automation-actions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const CONFIG_PATH = path.join(__dirname, "data", "dashboard.config.json");
const NEXT_PROJECTS_PATH = path.join(__dirname, "data", "next-projects.json");
const CHECKLIST_PATH = path.join(__dirname, "data", "checklist.json");
const PUBLIC_DIR = path.join(__dirname, "public");

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

// A missing checklist file behaves as an empty checklist so fresh clones
// (data/ is gitignored) render the tab without errors.
async function readChecklist() {
  try {
    return JSON.parse(await readFile(CHECKLIST_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { title: "Checklist", updatedAt: null, items: [] };
    }
    throw error;
  }
}

async function readConfig() {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
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
  // Mutating routes are same-origin only: a hostile web page can fire blind
  // cross-origin POSTs at localhost from the user's own browser, so reject
  // any browser request whose Origin does not match the addressed host.
  // Non-browser clients (curl, scripts) send no Origin and stay allowed.
  if (req.method !== "GET" && req.headers.origin) {
    let originHost = null;
    try {
      originHost = new URL(req.headers.origin).host;
    } catch {
      // Malformed Origin stays null and is rejected below.
    }
    if (!originHost || originHost !== req.headers.host) {
      sendJson(res, 403, { error: "Cross-origin write rejected" });
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
    const raw = await readFile(NEXT_PROJECTS_PATH, "utf8");
    sendJson(res, 200, JSON.parse(raw));
    return;
  }

  if (requestUrl.pathname === "/api/checklist") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Use GET for checklist" });
      return;
    }
    sendJson(res, 200, await readChecklist());
    return;
  }

  // Toggle one checklist item. The id is only matched against items already
  // in the checklist file; it never reaches the filesystem or a shell.
  const checklistMatch = requestUrl.pathname.match(/^\/api\/checklist\/items\/([A-Za-z0-9._-]+)\/toggle$/);
  if (checklistMatch) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Use POST for toggle" });
      return;
    }
    const checklist = await readChecklist();
    const item = (checklist.items || []).find((candidate) => candidate.id === checklistMatch[1]);
    if (!item) {
      sendJson(res, 404, { error: `Unknown checklist item: ${checklistMatch[1]}` });
      return;
    }
    item.done = !item.done;
    item.doneAt = item.done ? new Date().toISOString() : null;
    checklist.updatedAt = new Date().toISOString();
    await writeFile(CHECKLIST_PATH, JSON.stringify(checklist, null, 2) + "\n", "utf8");
    sendJson(res, 200, { updatedAt: checklist.updatedAt, item });
    return;
  }

  // Scheduled card actions. The id is only ever matched against automations
  // discovered on disk; it never reaches the filesystem or a shell.
  const automationMatch = requestUrl.pathname.match(/^\/api\/automations\/([A-Za-z0-9._-]+)\/(pause|resume|run|last-run)$/);
  if (automationMatch) {
    const [, automationId, action] = automationMatch;

    if (action === "last-run") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Use GET for last-run" });
        return;
      }
      const result = await getLastRun(automationId);
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
        const result = await runAutomation(automationId);
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
        if (error.code === "NO_CODEX" || error.code === "NO_PROMPT") {
          sendJson(res, 503, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    const result = await setAutomationStatus(automationId, action);
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

server.listen(PORT, HOST, () => {
  console.log(`Project dashboard running at http://${HOST}:${PORT}`);
});
