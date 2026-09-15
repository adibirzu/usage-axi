import { readFileSync } from "node:fs";
import { runCapture } from "../lib/process.js";
import { readJsonFile, readTextFile } from "../lib/fs.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRoot, MachineCapacity } from "../types.js";

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

/**
 * The adapter a command basename names, if any: an exact adapter name, or an
 * adapter followed by `-`, `_`, or `.` (e.g. `codex.js`, `muse-bin-1`). Exact
 * equality is checked across the whole list first so `pi-signed` resolves to
 * itself rather than to the `pi` prefix. Deliberately not a bare substring:
 * `pip` must never read as `pi`.
 */
function namesWorkerMatch(value: string): string | null {
  if (WORKER_NAMES.includes(value)) return value;
  for (const name of WORKER_NAMES) {
    if (value.startsWith(`${name}-`) || value.startsWith(`${name}_`) || value.startsWith(`${name}.`)) {
      return name;
    }
  }
  return null;
}

/**
 * The adapter named as a whole path or word component of an interpreter's argv,
 * anchored on both sides for the same reason (`python -m pi` matches; the `pi`
 * inside `pip` does not).
 */
function argvNamesWorkerMatch(value: string): string | null {
  for (const name of WORKER_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|/|\\s)${escaped}([-_./]|\\s|$)`).test(value)) return name;
  }
  return null;
}

function argvFrom(line: string): { pid: number; args: string } | null {
  const match = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!match) return null;
  return { pid: Number(match[1]), args: match[2] };
}

/**
 * Cursor private-worker / worker-start processes are long-lived service
 * daemons, not coding-agent task sessions. Token match on argv only, so a
 * standalone `cursor-agent` task still counts. `private-worker` and
 * `worker-start` are the flag forms; `worker … start` is the documented
 * `agent worker start` subcommand (flags may sit between the two words).
 */
const CURSOR_DAEMON_TOKEN_RE = /\b(?:private[-_]worker|worker-start)\b/i;
const CURSOR_WORKER_START_RE = /\bworker\b(?:\s+\S+)*\s+\bstart\b/i;

function isCursorBackgroundDaemon(match: string, args: string): boolean {
  if (match !== "cursor-agent") return false;
  return CURSOR_DAEMON_TOKEN_RE.test(args) || CURSOR_WORKER_START_RE.test(args);
}

/** True when `pid` has an ancestor (not itself) in `targets`. Depth-capped. */
function hasAncestorIn(
  pid: number,
  parent: ReadonlyMap<number, number>,
  targets: ReadonlySet<number>,
): boolean {
  let current = parent.get(pid);
  for (let depth = 0; depth < 64; depth += 1) {
    if (current === undefined) return false;
    if (targets.has(current)) return true;
    current = parent.get(current);
  }
  return false;
}

/** The result of one fleet reading over two ps snapshots. */
export type FleetReading = {
  agents: number | null;
  procs: number | null;
  residentMb: number | null;
  roots: AgentRoot[];
};

/**
 * Every pid in the process tree rooted at `rootPid`, from a comm snapshot
 * (`<pid> <ppid> <rss> <comm>` lines). Used to exclude usage-axi's own probe
 * processes from the agent count: `measureMachine` runs concurrently with the
 * `opencode models` catalog read, so without this the catalog's transient
 * `opencode` process incorrectly counts as a fleet agent and inflates `agents`.
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
 * Invocation-root fleet reading. Adapter matching is the same doctrine as
 * firstmate's `fm_capacity_fleet_totals` (basename, name-/_/. prefix, node/python
 * argv), but `agents` is the number of harness *invocations*, not matching
 * processes: a matching pid whose ancestor also matches is dropped, and Cursor
 * private-worker / worker-start daemons are not task sessions. `procs` and
 * `residentMb` still sum the whole tree under each remaining root (resident
 * kilobytes, integer-divided by 1024). `roots` lists every counted invocation
 * so `machine.agents` is auditable.
 *
 * This deliberately diverges from `fm_capacity_fleet_totals`, which still
 * counts each matching process. Do not edit firstmate in this change.
 * `excludePids` drops usage-axi's own transient probe tree only (see
 * `processTreePids`); it must never exclude an unrelated agent.
 */
export function readFleet(
  commSnapshot: string | null,
  argvSnapshot: string | null,
  excludePids: ReadonlySet<number> = new Set(),
): FleetReading {
  if (!commSnapshot) return { agents: null, procs: null, residentMb: null, roots: [] };
  const argv = new Map<number, string>();
  for (const line of (argvSnapshot ?? "").split("\n")) {
    const parsed = argvFrom(line);
    if (parsed) argv.set(parsed.pid, parsed.args);
  }
  const parent = new Map<number, number>();
  const size = new Map<number, number>();
  const known: number[] = [];
  const daemons = new Set<number>();
  const matches: AgentRoot[] = [];
  for (const line of commSnapshot.split("\n")) {
    const parsed = parsePs(line);
    if (!parsed || excludePids.has(parsed.pid)) continue;
    parent.set(parsed.pid, parsed.ppid);
    size.set(parsed.pid, parsed.rss);
    known.push(parsed.pid);
    const base = baseName(parsed.comm);
    let match = namesWorkerMatch(base);
    let via: AgentRoot["via"] = "comm";
    if (!match && (base.startsWith("node") || base.startsWith("python"))) {
      match = argvNamesWorkerMatch(argv.get(parsed.pid) ?? "");
      via = "argv";
    }
    if (!match) continue;
    if (isCursorBackgroundDaemon(match, argv.get(parsed.pid) ?? "")) {
      daemons.add(parsed.pid);
      continue;
    }
    matches.push({ pid: parsed.pid, comm: base, match, via });
  }
  const matching = new Set(matches.map((entry) => entry.pid));
  const roots = matches.filter(
    (entry) => !hasAncestorIn(entry.pid, parent, matching) && !hasAncestorIn(entry.pid, parent, daemons),
  );
  const root = new Set(roots.map((entry) => entry.pid));
  let residentKb = 0;
  let procs = 0;
  for (const pid of known) {
    // Walk to an invocation root. The depth cap keeps a corrupt or cyclic
    // snapshot from spinning.
    let current = pid;
    for (let depth = 0; depth < 64; depth += 1) {
      if (root.has(current)) {
        residentKb += size.get(pid) ?? 0;
        procs += 1;
        break;
      }
      const next = parent.get(current);
      if (next === undefined) break;
      current = next;
    }
  }
  return { agents: roots.length, procs, residentMb: Math.floor(residentKb / 1024), roots };
}

/**
 * Count live worker roots. Kept as the narrow, exported entry point the
 * snapshot tests use; `readFleet` carries the same invocation-root rule plus
 * the auditable roots and the tree sums.
 */
export function countWorkerRoots(
  commSnapshot: string | null,
  argvSnapshot: string | null,
  excludePids: ReadonlySet<number> = new Set(),
): number | null {
  return readFleet(commSnapshot, argvSnapshot, excludePids).agents;
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

/**
 * The two `ps` snapshots the worker-root rule reads, in the same two-file
 * format firstmate's own probe uses. A test or an operator can point these at
 * files (`ps -ax -o pid=,ppid=,rss=,comm=` and `ps -ax -o pid=,args=`) to
 * replay a captured machine exactly, including a macOS capture on another host;
 * both must be set to take effect.
 */
async function psSnapshots(): Promise<{ comm: string | null; argv: string | null; live: boolean }> {
  const commFile = process.env["USAGE_AXI_MACHINE_PS_COMM"];
  const argvFile = process.env["USAGE_AXI_MACHINE_PS_ARGV"];
  if (commFile && argvFile) {
    return { comm: readTextFile(commFile), argv: readTextFile(argvFile), live: false };
  }
  return {
    comm: await runText("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="]),
    argv: await runText("ps", ["-A", "-o", "pid=,args="]),
    live: true,
  };
}

export async function measureMachine(): Promise<MachineCapacity> {
  const fixture = fixtureMachine();
  if (fixture) return fixture;

  const [coreCount, load, freePct] = await Promise.all([cores(), load1(), memoryFreePct()]);
  const { comm: commSnapshot, argv: argvSnapshot, live } = await psSnapshots();

  const loadPerCore =
    coreCount && load !== null ? Math.round((load / coreCount) * 1000) / 1000 : null;

  // Exclude this process's own probe tree only for a live reading: the
  // concurrent `opencode models` catalog read matches the worker-name rule
  // but is not fleet work. A replayed snapshot is from another moment (possibly
  // another host), so its own pids must be counted exactly as captured. No
  // unrelated agent (an operator's grok/claude TUI, another worker) is ever
  // excluded.
  const exclude = live ? processTreePids(commSnapshot, process.pid) : new Set<number>();
  const fleet = readFleet(commSnapshot, argvSnapshot, exclude);

  return {
    agents: fleet.agents,
    agentCeiling: agentCeiling(),
    loadPerCore,
    memoryFreePct: freePct,
    suiteSlotFree: suiteSlotFree(argvSnapshot),
    roots: fleet.roots,
  };
}
