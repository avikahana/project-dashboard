import { syncProjects } from "../lib/project-sync.mjs";

const dryRun = process.argv.includes("--dry-run");
const result = await syncProjects({ write: !dryRun });

console.log(JSON.stringify({
  written: result.written,
  discovered: result.discovered,
  retained: result.retained,
  total: result.total,
  statusFiles: result.statusFiles,
  skippedRoots: result.skippedRoots,
  configPath: result.configPath
}, null, 2));
