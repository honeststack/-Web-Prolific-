import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { unzipSync } from "fflate";
import { ImageSource } from "./validate";

export function directorySource(root: string): ImageSource {
  return {
    label: root,
    folders: () => readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory()),
    files: (folder) => readdirSync(join(root, folder)),
    read: (folder, file) => {
      const path = join(root, folder, file);
      return existsSync(path) ? readFileSync(path) : null;
    },
  };
}

/**
 * Reads the supplied ZIP. Entries are looked up by name and never written to
 * disk from here, so path-traversal names in the archive cannot escape anywhere.
 * Expected layout: <anything>/RPLAN_triplets/<triplet_id>/{a,b,c}.png
 */
export function zipSource(zipPath: string): { source: ImageSource; csv: string | null } {
  const entries = unzipSync(readFileSync(zipPath));
  const byFolder = new Map<string, Map<string, Uint8Array>>();
  let csv: string | null = null;
  for (const [rawName, data] of Object.entries(entries)) {
    const name = posix.normalize(rawName.replace(/\\/g, "/"));
    if (name.startsWith("../") || name.endsWith("/")) continue;
    if (name.toLowerCase().endsWith(".csv") && csv === null) csv = Buffer.from(data).toString("utf8");
    const parts = name.split("/");
    if (parts.length < 2 || !parts[parts.length - 1].toLowerCase().endsWith(".png")) continue;
    const folder = parts[parts.length - 2];
    const file = parts[parts.length - 1];
    if (!byFolder.has(folder)) byFolder.set(folder, new Map());
    byFolder.get(folder)!.set(file, data);
  }
  return {
    csv,
    source: {
      label: zipPath,
      folders: () => [...byFolder.keys()],
      files: (folder) => [...(byFolder.get(folder)?.keys() ?? [])],
      read: (folder, file) => byFolder.get(folder)?.get(file) ?? null,
    },
  };
}
