import { afterEach, describe, expect, it } from "vitest";
import { loadQuotaAxi } from "../../src/sources/quota-axi.js";
import { clearUsageEnv, fixture } from "../support/harness.js";

afterEach(clearUsageEnv);

describe("quota-axi adapter", () => {
  it("passes windows and spendPriority through verbatim", async () => {
    process.env["USAGE_AXI_QUOTA_AXI_JSON"] = fixture("quota-axi-mac-20260913.json");
    const load = await loadQuotaAxi();
    expect(load.ok).toBe(true);
    if (!load.ok) return;

    const claude = load.providers.find((provider) => provider.provider === "claude");
    expect(claude?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day", "model:fable"]);
    expect(claude?.windows.find((window) => window.id === "seven_day")?.percentRemaining).toBe(23);
    const allModels = claude?.quotaSemantics.effectiveAvailability.find((entry) => entry.scope === "all_models");
    expect(allModels?.selection?.spendPriority).toBeCloseTo(-2.8739, 4);

    const cursor = load.providers.find((provider) => provider.provider === "cursor");
    const auto = cursor?.windows.find((window) => window.id === "auto_usage");
    expect(auto?.percentRemaining).toBe(99);
  });

  it("never carries account identity", async () => {
    process.env["USAGE_AXI_QUOTA_AXI_JSON"] = fixture("quota-axi-mac-20260913.json");
    const load = await loadQuotaAxi();
    if (!load.ok) throw new Error("expected load");
    for (const provider of load.providers) {
      expect(JSON.stringify(provider)).not.toContain("accountId");
      expect(JSON.stringify(provider)).not.toContain("REDACTED");
    }
  });

  it("reports unavailable sources without throwing", async () => {
    process.env["USAGE_AXI_QUOTA_AXI_JSON"] = "/nonexistent/quota.json";
    const load = await loadQuotaAxi();
    expect(load.ok).toBe(false);
  });
});
