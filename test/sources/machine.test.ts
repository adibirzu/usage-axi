import { afterEach, describe, expect, it } from "vitest";
import {
  countWorkerRoots,
  measureMachine,
  parseMemoryPressureFreePct,
  processTreePids,
} from "../../src/sources/machine.js";
import { MACHINE_FIXTURE, clearUsageEnv, tempDir, writeJson } from "../support/harness.js";

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
    // cursor-agent, opencode, node-argv-opencode, claude, pi-signed, codex.js = 6.
    // `pip` must never match `pi`, and the Cursor Helper must not match.
    expect(countWorkerRoots(comm, argv)).toBe(6);
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
    // Without the exclusion the probe inflates the count; with it the unrelated
    // opencode remains.
    expect(countWorkerRoots(comm, argv)).toBe(3);
    expect(countWorkerRoots(comm, argv, tree)).toBe(1);
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
