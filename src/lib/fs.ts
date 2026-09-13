import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export function readJsonFile(path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!existsSync(path)) return { ok: false, reason: `${path} is not readable` };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { ok: false, reason: `${path} is malformed JSON` };
  }
}

export function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function collapseHome(path: string): string {
  const home = homedir();
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
