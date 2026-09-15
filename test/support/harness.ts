import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { collectUsage } from "../../src/sources/index.js";
import { toJsonObject } from "../../src/render.js";
import type { SourceReport, UsageResponse } from "../../src/types.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(here, "..", "fixtures");
// Pinned read-only copy of firstmate origin/main bin/fm-dispatch-select.mjs
// (MIT, Copyright (c) 2026 Kun Chen). It is the exact consumer usage-axi must
// satisfy, vendored so the acceptance tests run in CI without the fork.
export const SELECTOR = join(here, "fm-dispatch-select.mjs");

const ENV_KEYS = [
  "USAGE_AXI_OPENUSAGE_JSON",
  "USAGE_AXI_QUOTA_AXI_JSON",
  "USAGE_AXI_OPENCODE_MODELS",
  "USAGE_AXI_MACHINE_JSON",
  "USAGE_AXI_MACHINE_PS_COMM",
  "USAGE_AXI_MACHINE_PS_ARGV",
  "USAGE_AXI_OPENUSAGE_BIN",
  "USAGE_AXI_QUOTA_AXI_BIN",
  "USAGE_AXI_OPENCODE_BIN",
  "USAGE_AXI_AGENT_CEILING",
  "USAGE_AXI_SUITE_BUSY",
];

export function clearUsageEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

export function fixture(name: string): string {
  return join(FIXTURES, name);
}

/**
 * Two-file ps snapshots plus the invocation-root golden. See
 * `test/fixtures/machine/README.md`; a macOS capture in the same format goes
 * here as `<host>-<YYYYMMDD>.{comm.ps,argv.ps,json}` and is exercised
 * automatically.
 */
export const MACHINE_FIXTURES = join(FIXTURES, "machine");

export type MachineSnapshotMeta = {
  source: string;
  platform: string;
  capturedAt: string;
  golden: { residentMb: number; agents: number; procs: number };
};

export function loadMachineSnapshot(
  base: string,
): { comm: string; argv: string; meta: MachineSnapshotMeta } | null {
  const metaPath = join(MACHINE_FIXTURES, `${base}.json`);
  const commPath = join(MACHINE_FIXTURES, `${base}.comm.ps`);
  const argvPath = join(MACHINE_FIXTURES, `${base}.argv.ps`);
  if (!existsSync(metaPath) || !existsSync(commPath) || !existsSync(argvPath)) return null;
  return {
    comm: readFileSync(commPath, "utf8"),
    argv: readFileSync(argvPath, "utf8"),
    meta: JSON.parse(readFileSync(metaPath, "utf8")) as MachineSnapshotMeta,
  };
}

export function machineSnapshotNames(): string[] {
  if (!existsSync(MACHINE_FIXTURES)) return [];
  return readdirSync(MACHINE_FIXTURES)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

/** A path that is guaranteed to be unreadable, to disable a source. */
export function missingFixture(): string {
  return join(tmpdir(), `usage-axi-missing-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

export function tempDir(prefix = "usage-axi-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

export const MACHINE_FIXTURE = {
  agents: 3,
  agentCeiling: 10,
  loadPerCore: 0.06,
  memoryFreePct: 58.9,
  suiteSlotFree: true,
};

/** Build the exact `usage-axi --json [--full]` payload for a set of sources. */
export async function buildUsage(
  env: Record<string, string>,
  full = true,
): Promise<{ payload: Record<string, unknown>; response: UsageResponse; reports: SourceReport[] }> {
  clearUsageEnv();
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    const { response, reports } = await collectUsage({ force: false });
    return { payload: toJsonObject(response, full, reports), response, reports };
  } finally {
    clearUsageEnv();
  }
}

/** Build usage from a raw quota-axi payload and the Mac OpenUsage capture. */
export async function macUsage(full = true) {
  const dir = mkdtempSync(join(tmpdir(), "usage-axi-machine-"));
  const machinePath = writeJson(dir, "machine.json", MACHINE_FIXTURE);
  const result = await buildUsage(
    {
      USAGE_AXI_OPENUSAGE_JSON: fixture("openusage-mac-20260913.json"),
      USAGE_AXI_QUOTA_AXI_JSON: fixture("quota-axi-mac-20260913.json"),
      USAGE_AXI_OPENCODE_MODELS: fixture("opencode-models-mac-20260913.txt"),
      USAGE_AXI_MACHINE_JSON: machinePath,
    },
    full,
  );
  rmSync(dir, { recursive: true, force: true });
  return result;
}

export type SelectorResult = { code: number; stdout: string; stderr: string };

/**
 * Run the vendored selector against a usage-axi payload. Profiles are the
 * candidate array the caller hands `select`; `now` fixes the clock so fixture
 * ages are deterministic.
 */
export async function runSelector(
  quotaFile: string,
  profiles: unknown,
  now: number,
  options: { config?: unknown } = {},
): Promise<SelectorResult> {
  const { dir, cleanup } = tempDir("usage-axi-sel-");
  const stateDir = join(dir, "state");
  const configDir = join(dir, "config");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  if (options.config !== undefined) {
    writeFileSync(join(configDir, "crew-dispatch.json"), JSON.stringify(options.config));
  }
  try {
    const result = await execFileAsync(
      process.execPath,
      [SELECTOR, "select", "--quota-json", quotaFile, "--now", String(now), JSON.stringify(profiles)],
      {
        env: {
          ...process.env,
          FM_HOME: dir,
          FM_STATE_OVERRIDE: stateDir,
          FM_CONFIG_OVERRIDE: configDir,
          FM_DISPATCH_STATE_FILE: join(stateDir, ".dispatch-routing.json"),
        },
        encoding: "utf8",
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  } finally {
    cleanup();
  }
}

export function epochOf(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}
