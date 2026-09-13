import { afterEach, describe, expect, it } from "vitest";
import {
  countWorkerRoots,
  measureMachine,
  parseMemoryPressureFreePct,
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
