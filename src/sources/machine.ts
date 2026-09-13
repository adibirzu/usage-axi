import { readFileSync } from "node:fs";
import { runCapture } from "../lib/process.js";
import { readJsonFile } from "../lib/fs.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MachineCapacity } from "../types.js";

// Ported from the measurement ideas in firstmate's bin/fm-capacity-lib.sh:
// one probe per signal, every probe returning a real reading or null, never a
// fabricated neutral value. No firstmate script is imported; these are fresh
// cross-platform probes. Unlike firstmate's guard, usage-axi only reports.

const WORKER_NAMES = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "pi-signed",
  "grok",
  "kimi",
  "cline",
  "cursor-agent",
  "copilot",
  "muse",
  "agy",
];

const TEST_RUNNER_RE =
  /(?:^|[\s/])(vitest|jest|mocha|ava|tap|pytest|phpunit|rspec|go test|cargo test|npm (?:run )?test|pnpm (?:run )?test|yarn (?:run )?test|bun (?:run )?test|deno test|gradle (?:run )?test|mvn (?:run )?test)(?:$|[\s])/;

async function runText(file: string, args: string[], mergeStderr = false): Promise<string | null> {
  const result = await runCapture(file, args, { includeStderr: mergeStderr });
  if (!result.ok) return null;
  const text = result.stdout.trim();
  return text.length ? text : null;
}

function readProc(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function cores(): Promise<number | null> {
  const sysctl = await runText("sysctl", ["-n", "hw.logicalcpu"]);
  if (sysctl && /^\d+$/.test(sysctl) && Number(sysctl) > 0) return Number(sysctl);
  const nproc = await runText("nproc", []);
  if (nproc && /^\d+$/.test(nproc) && Number(nproc) > 0) return Number(nproc);
  const getconf = await runText("getconf", ["_NPROCESSORS_ONLN"]);
  if (getconf && /^\d+$/.test(getconf) && Number(getconf) > 0) return Number(getconf);
  return null;
}

async function load1(): Promise<number | null> {
  const sysctl = await runText("sysctl", ["-n", "vm.loadavg"]);
  if (sysctl) {
    const match = sysctl.match(/\{?\s*([0-9.]+)/);
    if (match && Number.isFinite(Number(match[1]))) return Number(match[1]);
  }
  const proc = readProc("/proc/loadavg");
  if (proc) {
    const value = Number(proc.split(/\s+/)[0]);
    if (Number.isFinite(value)) return value;
  }
  const uptime = await runText("uptime", []);
  if (uptime) {
    const match = uptime.match(/load average[s]?:\s*([0-9.]+)/i);
    if (match && Number.isFinite(Number(match[1]))) return Number(match[1]);
  }
  return null;
}

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

async function darwinTotalMb(): Promise<number | null> {
  const memsize = await runText("sysctl", ["-n", "hw.memsize"]);
  if (memsize && /^\d+$/.test(memsize) && Number(memsize) > 0) {
    return Math.round(Number(memsize) / 1024 / 1024);
  }
  return null;
}

/**
 * macOS `memory_pressure -Q` prints "System-wide memory free percentage: N%".
 * That is the free-memory reading the operator sees (it counts reclaimable
 * inactive/purgeable pages), unlike raw `vm_stat` free pages which macOS keeps
 * pinned near zero. fm-capacity-lib.sh's memory bar is calibrated to this.
 */
export function parseMemoryPressureFreePct(report: string): number | null {
  const match = report.match(/System-wide memory free percentage:\s*(\d+)%/i);
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 0 && value <= 100 ? value : null;
}

async function darwinPressureFreePct(): Promise<number | null> {
  // memory_pressure reports on stderr on at least some macOS builds.
  const report = await runText("memory_pressure", ["-Q"], true);
  if (!report) return null;
  return parseMemoryPressureFreePct(report);
}

/** Fallback: vm_stat free+speculative pages as a percentage of installed RAM. */
async function darwinVmStatFreePct(): Promise<number | null> {
  const vmStat = await runText("vm_stat", []);
  if (!vmStat) return null;
  const pageMatch = vmStat.match(/page size of (\d+)/);
  const freeMatch = vmStat.match(/^Pages free:\s+(\d+)/m);
  const specMatch = vmStat.match(/^Pages speculative:\s+(\d+)/m);
  if (!pageMatch || !freeMatch) return null;
  const totalMb = await darwinTotalMb();
  if (!totalMb) return null;
  const pages = Number(freeMatch[1]) + (specMatch ? Number(specMatch[1]) : 0);
  const freeMb = (pages * Number(pageMatch[1])) / 1024 / 1024;
  return roundPct((freeMb / totalMb) * 100);
}

/**
 * Free memory as a percent. macOS reads the OS's own free percentage from
 * `memory_pressure -Q` (falling back to vm_stat free+speculative). Linux keeps
 * MemAvailable, the kernel's reclaimable-cache estimate - never MemFree.
 */
async function memoryFreePct(): Promise<number | null> {
  if (process.platform === "darwin") {
    const pressure = await darwinPressureFreePct();
    if (pressure !== null) return pressure;
    return darwinVmStatFreePct();
  }
  const proc = readProc("/proc/meminfo");
  if (proc) {
    const total = proc.match(/^MemTotal:\s+(\d+)\s+kB/m);
    const available = proc.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (total && available) {
      const totalKb = Number(total[1]);
      if (totalKb > 0) return roundPct((Number(available[1]) / totalKb) * 100);
    }
  }
  return null;
}

function parsePs(line: string): { pid: number; ppid: number; rss: number; comm: string } | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
  if (!match) return null;
  return { pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]), comm: match[4] };
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function namesWorker(value: string): boolean {
  return WORKER_NAMES.some(
    (name) => value === name || value.startsWith(`${name}-`) || value.startsWith(`${name}_`) || value.startsWith(`${name}.`),
  );
}

function argvNamesWorker(value: string): boolean {
  return WORKER_NAMES.some((name) => new RegExp(`(^|/|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([-_./]|\\s|$)`).test(value));
}

function argvFrom(line: string): { pid: number; args: string } | null {
  const match = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!match) return null;
  return { pid: Number(match[1]), args: match[2] };
}

/**
 * Every pid in the process tree rooted at `rootPid`, from a comm snapshot
 * (`<pid> <ppid> <rss> <comm>` lines). Used to exclude usage-axi's own probe
 * processes from the agent count: `measureMachine` runs concurrently with the
 * `opencode models` catalog read, so without this the catalog's transient
 * `opencode` process counts as a fleet agent and inflates `agents` above what
 * `fm-capacity-lib.sh` (which spawns no probes) reports for the same instant.
 */
export function processTreePids(commSnapshot: string | null, rootPid: number): Set<number> {
  const tree = new Set<number>([rootPid]);
  if (!commSnapshot) return tree;
  const children = new Map<number, number[]>();
  for (const line of commSnapshot.split("\n")) {
    const parsed = parsePs(line);
    if (!parsed) continue;
    const siblings = children.get(parsed.ppid);
    if (siblings) siblings.push(parsed.pid);
    else children.set(parsed.ppid, [parsed.pid]);
  }
  const stack = [rootPid];
  while (stack.length) {
    const parent = stack.pop() as number;
    for (const child of children.get(parent) ?? []) {
      if (tree.has(child)) continue;
      tree.add(child);
      stack.push(child);
    }
  }
  return tree;
}

/**
 * Count live worker roots, matching firstmate's adapter-name doctrine. A
 * process is a root when its command basename equals a firstmate adapter name
 * (claude, codex, opencode, pi, pi-signed, grok, kimi, cline, cursor-agent,
 * copilot, muse, agy) or begins with that name followed by `-`, `_`, or `.`;
 * when the basename is a bare `node`/`python`, its argv is searched for the
 * adapter as a path or word component instead. Each matching process counts
 * once. `excludePids` drops this process's own probe tree (transients), so the
 * `opencode models` catalog read does not count as a fleet agent. Kept exported
 * and pure so the worker-root rule can be exercised against fixed ps snapshots.
 */
export function countWorkerRoots(
  commSnapshot: string | null,
  argvSnapshot: string | null,
  excludePids: ReadonlySet<number> = new Set(),
): number | null {
  if (!commSnapshot) return null;
  const argv = new Map<number, string>();
  for (const line of (argvSnapshot ?? "").split("\n")) {
    const parsed = argvFrom(line);
    if (parsed) argv.set(parsed.pid, parsed.args);
  }
  let agents = 0;
  for (const line of commSnapshot.split("\n")) {
    const parsed = parsePs(line);
    if (!parsed || excludePids.has(parsed.pid)) continue;
    const base = baseName(parsed.comm);
    let hit = namesWorker(base);
    if (!hit && (base.startsWith("node") || base.startsWith("python"))) {
      hit = argvNamesWorker(argv.get(parsed.pid) ?? "");
    }
    if (hit) agents += 1;
  }
  return agents;
}

function suiteSlotFree(argvSnapshot: string | null): boolean | null {
  const override = process.env["USAGE_AXI_SUITE_BUSY"];
  if (override === "1") return false;
  if (override === "0") return true;
  if (!argvSnapshot) return null;
  for (const line of argvSnapshot.split("\n")) {
    const parsed = argvFrom(line);
    if (!parsed || parsed.pid === process.pid) continue;
    if (TEST_RUNNER_RE.test(parsed.args)) return false;
  }
  return true;
}

function agentCeiling(): number {
  const env = process.env["USAGE_AXI_AGENT_CEILING"];
  if (env && /^\d+$/.test(env) && Number(env) > 0) return Number(env);
  const config = join(homedir(), ".config", "usage-axi", "config.json");
  const read = readJsonFile(config);
  if (read.ok && read.value && typeof read.value === "object") {
    const value = (read.value as Record<string, unknown>)["agentCeiling"];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return 10;
}

function fixtureMachine(): MachineCapacity | null {
  const fixture = process.env["USAGE_AXI_MACHINE_JSON"];
  if (!fixture) return null;
  const read = readJsonFile(fixture);
  if (!read.ok || !read.value || typeof read.value !== "object") return null;
  const raw = read.value as Record<string, unknown>;
  const num = (key: string): number | null => (typeof raw[key] === "number" ? (raw[key] as number) : null);
  const machine: MachineCapacity = {
    agents: num("agents"),
    agentCeiling: typeof raw["agentCeiling"] === "number" ? (raw["agentCeiling"] as number) : agentCeiling(),
    loadPerCore: num("loadPerCore"),
    memoryFreePct: num("memoryFreePct"),
    suiteSlotFree: typeof raw["suiteSlotFree"] === "boolean" ? (raw["suiteSlotFree"] as boolean) : null,
  };
  return machine;
}

export async function measureMachine(): Promise<MachineCapacity> {
  const fixture = fixtureMachine();
  if (fixture) return fixture;

  const [coreCount, load, freePct] = await Promise.all([cores(), load1(), memoryFreePct()]);
  const commSnapshot = await runText("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="]);
  const argvSnapshot = await runText("ps", ["-A", "-o", "pid=,args="]);

  const loadPerCore =
    coreCount && load !== null ? Math.round((load / coreCount) * 1000) / 1000 : null;

  return {
    agents: countWorkerRoots(commSnapshot, argvSnapshot, processTreePids(commSnapshot, process.pid)),
    agentCeiling: agentCeiling(),
    loadPerCore,
    memoryFreePct: freePct,
    suiteSlotFree: suiteSlotFree(argvSnapshot),
  };
}
