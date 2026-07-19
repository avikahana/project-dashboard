import { execFile } from "node:child_process";

// Everything a PR card needs, in one gh call per repo.
const PR_FIELDS = "number,title,url,isDraft,author,headRefName,updatedAt,reviewDecision,statusCheckRollup,mergeable";

// gh goes over the network to the GitHub API; one hung or throttled repo must
// not hold the endpoint hostage, so each call gets its own hard deadline.
const GH_TIMEOUT_MS = 10000;

// Same pattern as the server's projectsCache: the frontend polls every minute
// from every open tab, and each scan spends GitHub API rate limit, so one
// in-flight scan serves all callers until the TTL lapses.
const PRS_CACHE_TTL_MS = 60000;
let prsCache = { at: 0, promise: null };

// The two remote forms git writes for GitHub: https://github.com/owner/name(.git)
// and git@github.com:owner/name(.git). Anything else is not a GitHub repo and
// is skipped rather than reported as an error.
const GITHUB_REMOTE_PATTERNS = [
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
];

function githubSlug(remoteUrl) {
  for (const pattern of GITHUB_REMOTE_PATTERNS) {
    const match = String(remoteUrl || "").match(pattern);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

function execGh(args) {
  return new Promise((resolve) => {
    execFile("gh", args, { timeout: GH_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          notInstalled: error.code === "ENOENT",
          message: String(stderr || "").trim() || error.message
        });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });
}

// statusCheckRollup mixes CheckRun entries (status + conclusion) with commit
// StatusContext entries (state only), so both vocabularies are folded into
// one checkStatus the UI can badge directly.
const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED"]);
const FAILING_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATUSES = new Set(["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"]);

function rollupCheckStatus(rollup) {
  const entries = Array.isArray(rollup) ? rollup : [];
  if (entries.length === 0) return "none";
  let pending = false;
  for (const entry of entries) {
    if (FAILING_CONCLUSIONS.has(entry.conclusion) || FAILING_STATES.has(entry.state)) return "failing";
    if (PENDING_STATUSES.has(entry.status) || entry.state === "PENDING") pending = true;
  }
  return pending ? "pending" : "passing";
}

async function scanRepo(repo) {
  const result = await execGh(["pr", "list", "--repo", repo, "--state", "open", "--json", PR_FIELDS]);
  if (!result.ok) return { repo, error: result };

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { repo, error: { message: "gh returned unparseable JSON" } };
  }

  return {
    repo,
    prs: (Array.isArray(parsed) ? parsed : []).map((pr) => ({
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login || null,
      headRefName: pr.headRefName,
      updatedAt: pr.updatedAt,
      isDraft: Boolean(pr.isDraft),
      checkStatus: rollupCheckStatus(pr.statusCheckRollup),
      reviewDecision: pr.reviewDecision || null,
      mergeable: pr.mergeable || null
    }))
  };
}

async function loadWaitingPrs(projects) {
  const repos = [...new Set(
    projects.map((project) => githubSlug(project.git?.remoteUrl)).filter(Boolean)
  )].sort();

  const results = await Promise.all(repos.map(scanRepo));

  // A missing gh binary is a machine-level condition, not a per-repo failure:
  // collapse the identical ENOENT errors into the one hint the UI shows.
  if (results.some((result) => result.error?.notInstalled)) {
    return {
      generatedAt: new Date().toISOString(),
      prs: [],
      errors: [{ repo: null, message: "gh CLI not found" }]
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    prs: results
      .flatMap((result) => result.prs || [])
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
    // A repo gh cannot reach (no access, rate limit) degrades to a note here
    // while every other repo's PRs still come back.
    errors: results
      .filter((result) => result.error)
      .map((result) => ({ repo: result.repo, message: result.error.message }))
  };
}

export function getWaitingPrs(projects) {
  const fresh = prsCache.promise && Date.now() - prsCache.at < PRS_CACHE_TTL_MS;
  if (fresh) return prsCache.promise;

  const promise = loadWaitingPrs(projects);
  promise.catch(() => {
    if (prsCache.promise === promise) {
      prsCache = { at: 0, promise: null };
    }
  });
  prsCache = { at: Date.now(), promise };
  return promise;
}
