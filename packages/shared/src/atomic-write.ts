import { renameSync, writeFileSync } from "node:fs";

/** Write a file via tmpfile + rename, so consumers never see a partial. */
export function atomicWriteFile(
  path: string,
  contents: string | Buffer,
): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}
