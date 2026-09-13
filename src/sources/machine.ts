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

async function runText(file: string, args: string[]): Promise<string | null> {
  const result = await runCapture(file, args);
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

async function memory(): Promise<{ totalMb: number; freeMb: number } | null> {
  const memsize = await runText("sysctl", ["-n", "hw.memsize"]);
  if (memsize && /^\d+$/.test(memsize) && Number(memsize) > 0) {
    const totalMb = Math.round(Number(memsize) / 1024 / 1024);
    const freeMb = await darwinFreeMb();
    if (freeMb !== null) return { totalMb, freeMb };
  }
  const proc = readProc("/proc/meminfo");
  if (proc) {
    const total = proc.match(/^MemTotal:\s+(\d+)\s+kB/m);
    const available = proc.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (total) {
      const totalMb = Math.round(Number(total[1]) / 1024);
      const freeMb = available ? Math.round(Number(available[1]) / 1024) : null;
      if (freeMb !== null && totalMb > 0) return { totalMb, freeMb };
    }
  }
  return null;
}

async function darwinFreeMb(): Promise<number | null> {
  const vmStat = await runText("vm_stat", []);
  if (!vmStat) return null;
  const pageMatch = vmStat.match(/page size of (\d+)/);
  const freeMatch = vmStat.match(/^Pages free:\s+(\d+)/m);
  const specMatch = vmStat.match(/^Pages speculative:\s+(\d+)/m);
  if (!pageMatch || !freeMatch) return null;
  const pageSize = Number(pageMatch[1]);
  const pages = Number(freeMatch[1]) + (specMatch ? Number(specMatch[1]) : 0);
  return Math.round((pages * pageSize) / 1024 / 1024);
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

/** Count live worker roots, matching firstmate's adapter-name doctrine. */
function countAgents(commSnapshot: string | null, argvSnapshot: string | null): number | null {
  if (!commSnapshot) return null;
  const argv = new Map<number, string>();
  for (const line of (argvSnapshot ?? "").split("\n")) {
    const parsed = argvFrom(line);
    if (parsed) argv.set(parsed.pid, parsed.args);
  }
  let agents = 0;
  for (const line of commSnapshot.split("\n")) {
    const parsed = parsePs(line);
    if (!parsed) continue;
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

  const [coreCount, load, mem] = await Promise.all([cores(), load1(), memory()]);
  const commSnapshot = await runText("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="]);
  const argvSnapshot = await runText("ps", ["-A", "-o", "pid=,args="]);

  const loadPerCore =
    coreCount && load !== null ? Math.round((load / coreCount) * 1000) / 1000 : null;
  const memoryFreePct =
    mem && mem.totalMb > 0 ? Math.round((mem.freeMb / mem.totalMb) * 1000) / 10 : null;

  return {
    agents: countAgents(commSnapshot, argvSnapshot),
    agentCeiling: agentCeiling(),
    loadPerCore,
    memoryFreePct,
    suiteSlotFree: suiteSlotFree(argvSnapshot),
  };
}
