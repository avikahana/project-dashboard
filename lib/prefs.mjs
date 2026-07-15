import path from "node:path";
import { readJson, writeJsonAtomic } from "./json-files.mjs";
import { ROOT_DIR } from "./sync-config.mjs";

// Cross-browser dashboard preferences. The Private list lives here (not in
// localStorage) so hiding a project holds on every origin the dashboard is
// reached from (localhost and a tunnel hostname are separate localStorage
// worlds). The file sits in data/, which is gitignored: which projects are
// hidden is itself private.
const PREFS_PATH = path.join(ROOT_DIR, "data", "dashboard.prefs.json");

async function readPrefsFile() {
  const raw = await readJson(PREFS_PATH, null);
  const hidden = Array.isArray(raw?.hiddenProjects)
    ? raw.hiddenProjects.filter((value) => typeof value === "string" && value)
    : [];
  return { schemaVersion: 1, hiddenProjects: hidden };
}

export async function getHiddenProjects() {
  return (await readPrefsFile()).hiddenProjects;
}

// Serialize writes within the process: an overlapping read-modify-write of
// dashboard.prefs.json could otherwise drop a concurrent hide/unhide.
let activeWrite = Promise.resolve();

export function setProjectHidden(projectId, hidden) {
  const run = activeWrite.then(apply, apply);
  activeWrite = run.then(() => undefined, () => undefined);
  return run;

  async function apply() {
    const prefs = await readPrefsFile();
    const ids = new Set(prefs.hiddenProjects);
    if (hidden) {
      ids.add(projectId);
    } else {
      ids.delete(projectId);
    }
    const next = { ...prefs, hiddenProjects: [...ids].sort() };
    await writeJsonAtomic(PREFS_PATH, `${JSON.stringify(next, null, 2)}\n`);
    return next.hiddenProjects;
  }
}
