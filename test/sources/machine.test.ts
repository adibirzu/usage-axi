import { afterEach, describe, expect, it } from "vitest";
import {
  countWorkerRoots,
  measureMachine,
  parseMemoryPressureFreePct,
  processTreePids,
  readFleet,
} from "../../src/sources/machine.js";
import {
  MACHINE_FIXTURE,
  clearUsageEnv,
  loadMachineSnapshot,
  machineSnapshotNames,
  tempDir,
  writeJson,
} from "../support/harness.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

afterEach(clearUsageEnv);

describe("machine adapter", () => {
  it("honours an injected machine reading", async () => {
    const { dir, cleanup } = tempDir();
    process.env["USAGE_AXI_MACHINE_JSON"] = writeJson(dir, "machine.json", MACHINE_FIXTURE);
    const machine = await measureMachine();
    cleanup();
    expect(machine.agents).toBe(3);
    expect(machine.agentCeiling).toBe(10);
    expect(machine.loadPerCore).toBe(0.06);
    expect(machine.memoryFreePct).toBe(58.9);
    expect(machine.suiteSlotFree).toBe(true);
  });

  it("measures the live machine without fabricating values", async () => {
    const machine = await measureMachine();
    expect(machine.agentCeiling).toBeGreaterThan(0);
    if (machine.loadPerCore !== null) expect(machine.loadPerCore).toBeGreaterThanOrEqual(0);
    if (machine.memoryFreePct !== null) {
      expect(machine.memoryFreePct).toBeGreaterThanOrEqual(0);
      expect(machine.memoryFreePct).toBeLessThanOrEqual(100);
    }
    expect([true, false, null]).toContain(machine.suiteSlotFree);
  });

  it("lets the suite-busy override win over process scanning", async () => {
    process.env["USAGE_AXI_SUITE_BUSY"] = "1";
    expect((await measureMachine()).suiteSlotFree).toBe(false);
    process.env["USAGE_AXI_SUITE_BUSY"] = "0";
    expect((await measureMachine()).suiteSlotFree).toBe(true);
  });
});

describe("worker-root agent counting", () => {
  it("counts adapter basenames, node/python argv roots, and boundary matches once", () => {
    // macOS ps prints absolute executable paths for comm.
    const comm = [
      "  100     1    1024 /Applications/Cursor.app/Contents/MacOS/cursor-agent",
      "  101   100    2048 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper",
      "  200     1    4096 /usr/local/bin/opencode",
      "  201   200    8192 node",
      "  300     1    1024 /usr/bin/pip",
      "  301     1    1024 python",
      "  400     1    1024 /Applications/Claude.app/Contents/MacOS/claude",
      "  500     1    1024 /usr/local/bin/pi-signed",
      "  600     1    1024 /usr/local/bin/codex.js",
    ].join("\n");
    const argv = [
      "  201 node /Users/adi/.opencode/bin/opencode run",
      "  301 python -m pip install foo",
    ].join("\n");
    // cursor-agent, opencode (child node-argv collapsed), claude, pi-signed, codex.js = 5.
    // `pip` must never match `pi`, and the Cursor Helper must not match.
    expect(countWorkerRoots(comm, argv)).toBe(5);
  });

  it("counts a Codex node wrapper, binary, and codex-code-mode-host as one invocation", () => {
    const comm = [
      "  100     1    4096 node",
      "  101   100    8192 /opt/homebrew/bin/codex",
      "  102   101    2048 /opt/homebrew/bin/codex-code-mode-host",
    ].join("\n");
    const argv = [
      "  100 node /opt/homebrew/bin/codex",
      "  101 /opt/homebrew/bin/codex",
      "  102 /opt/homebrew/bin/codex-code-mode-host",
    ].join("\n");
    const fleet = readFleet(comm, argv);
    expect(fleet.agents).toBe(1);
    expect(fleet.roots).toEqual([{ pid: 100, comm: "node", match: "codex", via: "argv" }]);
    expect(fleet.procs).toBe(3);
  });

  it("excludes Cursor private-worker and worker-start daemons but counts a standalone cursor-agent", () => {
    const comm = [
      "  100     1    1024 /Applications/Cursor.app/Contents/MacOS/Cursor",
      "  101   100    2048 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper",
      "  110   100    4096 /Applications/Cursor.app/Contents/MacOS/cursor-agent",
      "  111   110     512 /usr/local/bin/cursor-agent",
      "  120     1    3072 /usr/local/bin/cursor-agent",
      "  200     1    8192 /usr/local/bin/cursor-agent",
    ].join("\n");
    const argv = [
      "  110 /Applications/Cursor.app/Contents/MacOS/cursor-agent worker start --worker-dir /Users/adi/project",
      "  111 /usr/local/bin/cursor-agent",
      "  120 /usr/local/bin/cursor-agent --use-system-ca private-worker",
      "  200 /usr/local/bin/cursor-agent --print --trust",
    ].join("\n");
    const fleet = readFleet(comm, argv);
    expect(fleet.agents).toBe(1);
    expect(fleet.roots).toEqual([{ pid: 200, comm: "cursor-agent", match: "cursor-agent", via: "comm" }]);
  });

  it("returns null when the comm snapshot could not be read", () => {
    expect(countWorkerRoots(null, "  1 node /x/opencode")).toBeNull();
  });

  it("excludes usage-axi's own transient probe tree from the fleet count", () => {
    // usage-axi's `opencode models` catalog read runs concurrently with the ps
    // scan. It is a child of this process, so it must not count as an agent;
    // an unrelated opencode still does.
    const self = process.pid;
    const comm = [
      `${self} 1 1000 node`,
      `${self + 1} ${self} 1000 opencode`,
      `${self + 2} ${self + 1} 1000 node`,
      `424242 1 1000 opencode`,
    ].join("\n");
    const argv = [
      `${self} node /x/usage-axi.js`,
      `${self + 2} node /x/opencode/server.js`,
    ].join("\n");

    const tree = processTreePids(comm, self);
    expect(tree.has(self + 1)).toBe(true);
    expect(tree.has(self + 2)).toBe(true);
    expect(tree.has(424242)).toBe(false);
    // Without the exclusion the probe inflates the count (the probe opencode
    // and its node child collapse to one invocation, plus the unrelated
    // opencode); with it the unrelated opencode remains.
    expect(countWorkerRoots(comm, argv)).toBe(2);
    expect(countWorkerRoots(comm, argv, tree)).toBe(1);
  });
});

describe("fleet reading invocation-root goldens", () => {
  it("reproduces the invocation-root golden on every ps snapshot fixture", () => {
    const names = machineSnapshotNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const snapshot = loadMachineSnapshot(name);
      expect(snapshot, `missing fixture files for ${name}`).not.toBeNull();
      if (!snapshot) continue;
      const fleet = readFleet(snapshot.comm, snapshot.argv);
      expect(
        { residentMb: fleet.residentMb, agents: fleet.agents, procs: fleet.procs },
        `fixture ${name}`,
      ).toEqual(snapshot.meta.golden);
    }
  });

  it("prints the real adi1 snapshot's roots so machine.agents is auditable", async () => {
    const snapshot = loadMachineSnapshot("adi1-20260913");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    const { dir, cleanup } = tempDir();
    const commPath = join(dir, "comm.ps");
    const argvPath = join(dir, "argv.ps");
    writeFileSync(commPath, snapshot.comm);
    writeFileSync(argvPath, snapshot.argv);
    process.env["USAGE_AXI_MACHINE_PS_COMM"] = commPath;
    process.env["USAGE_AXI_MACHINE_PS_ARGV"] = argvPath;
    const machine = await measureMachine();
    cleanup();
    expect(machine.agents).toBe(snapshot.meta.golden.agents);
    expect(machine.roots).toHaveLength(snapshot.meta.golden.agents);
    expect(machine.roots?.some((root) => root.match === "opencode")).toBe(true);
    expect(machine.roots?.some((root) => root.match === "grok" && root.comm === "grok")).toBe(true);
    // Identity only: pid, basename, adapter, matching channel. Never argv body.
    for (const root of machine.roots ?? []) {
      expect(Object.keys(root).sort()).toEqual(["comm", "match", "pid", "via"]);
    }
  });

  it("loads a macOS two-file snapshot in the same format", async () => {
    // macOS ps prints absolute executable paths, some with spaces; a bare
    // node/python basename is resolved from its argv instead.
    const comm = [
      "  100     1    1024 /Applications/Claude.app/Contents/MacOS/claude",
      "  101     1    2048 /Users/op/Library/Application Support/my tools/opencode",
      "  200     1    4096 /usr/bin/pip",
      "  201   200    8192 /opt/homebrew/bin/node",
      "  202     1    1024 MainThread",
    ].join("\n");
    const argv = "  201 node /Users/op/.npm/lib/node_modules/@anthropic-ai/claude-code/cli.js";
    const { dir, cleanup } = tempDir();
    writeFileSync(join(dir, "comm.ps"), comm);
    writeFileSync(join(dir, "argv.ps"), argv);
    process.env["USAGE_AXI_MACHINE_PS_COMM"] = join(dir, "comm.ps");
    process.env["USAGE_AXI_MACHINE_PS_ARGV"] = join(dir, "argv.ps");
    const machine = await measureMachine();
    cleanup();
    expect(machine.agents).toBe(3);
    expect(machine.roots?.map((root) => root.match).sort()).toEqual(["claude", "claude", "opencode"]);
  });
});

describe("macOS memory free percentage", () => {
  it("parses memory_pressure -Q and rejects non-readings", () => {
    const report =
      "The system has 17179869184 (1048576 pages with a page size of 16384).\n\n" +
      "System-wide memory free percentage: 22%\n";
    expect(parseMemoryPressureFreePct(report)).toBe(22);
    expect(parseMemoryPressureFreePct("no reading here")).toBeNull();
    expect(parseMemoryPressureFreePct("System-wide memory free percentage: 140%")).toBeNull();
  });
});
