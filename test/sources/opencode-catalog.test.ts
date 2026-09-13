import { afterEach, describe, expect, it } from "vitest";
import { loadOpencodeCatalog } from "../../src/sources/opencode-catalog.js";
import { clearUsageEnv, fixture } from "../support/harness.js";

afterEach(clearUsageEnv);

describe("opencode-catalog adapter", () => {
  it("splits models into opencode-go and opencode pools", async () => {
    process.env["USAGE_AXI_OPENCODE_MODELS"] = fixture("opencode-models-mac-20260913.txt");
    const load = await loadOpencodeCatalog();
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.total).toBe(111);
    const go = load.pools.find((pool) => pool.id === "opencode-go");
    const free = load.pools.find((pool) => pool.id === "opencode");
    expect(go?.models.length).toBe(27);
    expect(free?.models.length).toBe(69);
    expect(go?.models).toContain("opencode-go/deepseek-v4.1-flash");
    expect(free?.models).toContain("opencode/big-pickle");
    expect(load.otherCount).toBe(15);
  });

  it("reports an unreadable catalog without throwing", async () => {
    process.env["USAGE_AXI_OPENCODE_MODELS"] = "/nonexistent/models.txt";
    const load = await loadOpencodeCatalog();
    expect(load.ok).toBe(false);
  });
});
