import path from "node:path";
import { readJson, writeJsonAtomic } from "./json-files.mjs";
import { ROOT_DIR } from "./sync-config.mjs";

// Standalone checklist (currently the Knowledge Expanders learning list).
// Unlike the Projects Next Steps list, check state here is persisted into the
// file itself so it holds across browsers and machines syncing data/.
const CHECKLIST_PATH = path.join(ROOT_DIR, "data", "checklist.json");

const EMPTY_CHECKLIST = { title: null, description: null, updatedAt: null, items: [] };

export async function getChecklist() {
  const raw = await readJson(CHECKLIST_PATH, null);
  if (!raw || !Array.isArray(raw.items)) return EMPTY_CHECKLIST;
  return raw;
}

// Serialize writes within the process: an overlapping read-modify-write of
// checklist.json could otherwise drop a concurrent check/uncheck.
let activeWrite = Promise.resolve();

export function setChecklistItemDone(itemId, done) {
  const run = activeWrite.then(apply, apply);
  activeWrite = run.then(() => undefined, () => undefined);
  return run;

  async function apply() {
    const checklist = await readJson(CHECKLIST_PATH, null);
    if (!checklist || !Array.isArray(checklist.items)) return null;
    const item = checklist.items.find((entry) => entry.id === itemId);
    if (!item) return null;
    item.done = done;
    item.doneAt = done ? new Date().toISOString() : null;
    checklist.updatedAt = new Date().toISOString();
    await writeJsonAtomic(CHECKLIST_PATH, `${JSON.stringify(checklist, null, 2)}\n`);
    return item;
  }
}
