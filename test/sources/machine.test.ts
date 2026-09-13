import { afterEach, describe, expect, it } from "vitest";
import { measureMachine } from "../../src/sources/machine.js";
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
