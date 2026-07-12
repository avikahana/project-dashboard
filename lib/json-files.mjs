import { readFile, rename, writeFile } from "node:fs/promises";

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

// Write via a temp file + rename so a crash or concurrent reader never sees
// a partially written file.
export async function writeJsonAtomic(filePath, body) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, body);
  await rename(tempPath, filePath);
}
