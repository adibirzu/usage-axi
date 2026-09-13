import { afterEach, describe, expect, it } from "vitest";
import { loadOpenUsage } from "../../src/sources/openusage.js";
import { clearUsageEnv, fixture } from "../support/harness.js";

afterEach(clearUsageEnv);

describe("openusage adapter", () => {
  it("maps every resource to a quota-axi window id", async () => {
    process.env["USAGE_AXI_OPENUSAGE_JSON"] = fixture("openusage-mac-20260913.json");
    const load = await loadOpenUsage(false);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    const providers = new Map(load.providers.map((provider) => [provider.provider, provider]));

    const claude = providers.get("claude");
    expect(claude?.windows.map((window) => window.id)).toEqual(["model:fable", "five_hour", "seven_day"]);
    expect(claude?.windows.find((window) => window.id === "five_hour")?.percentRemaining).toBe(92);
    expect(claude?.windows.find((window) => window.id === "seven_day")?.percentRemaining).toBe(23);

    const cursor = providers.get("cursor");
    const auto = cursor?.windows.find((window) => window.id === "auto_usage");
    const api = cursor?.windows.find((window) => window.id === "api_usage");
    expect(auto?.percentRemaining).toBeCloseTo(99.1555, 3);
    expect(api?.percentRemaining).toBe(0);

    // antigravity is presented under the selector's provider identity, agy.
    expect(providers.has("agy")).toBe(true);
    expect(providers.has("antigravity")).toBe(false);
    expect(providers.get("agy")?.windows.map((window) => window.id)).toEqual([
      "gemini_5h",
      "gemini_weekly",
      "claude_gpt_5h",
      "claude_gpt_weekly",
    ]);

    expect(providers.get("opencode")?.windows.map((window) => window.id)).toEqual([
      "monthly",
      "session",
      "weekly",
    ]);
    expect(providers.get("grok")?.windows[0]?.id).toBe("credits");
  });

  it("keeps balance resources out of the priced percentages", async () => {
    process.env["USAGE_AXI_OPENUSAGE_JSON"] = fixture("openusage-mac-20260913.json");
    const load = await loadOpenUsage(false);
    if (!load.ok) throw new Error("expected load");
    const codex = load.providers.find((provider) => provider.provider === "codex");
    const credits = codex?.windows.find((window) => window.id === "credits");
    expect(credits).toBeDefined();
    expect(credits?.percentRemaining).toBeUndefined();
    expect(codex?.windows.find((window) => window.id === "weekly")?.percentRemaining).toBe(57);
  });

  it("maps cursor Auto as a live pool without letting API zero hide it", async () => {
    process.env["USAGE_AXI_OPENUSAGE_JSON"] = fixture("openusage-mac-20260913.json");
    const load = await loadOpenUsage(false);
    if (!load.ok) throw new Error("expected load");
    const cursor = load.providers.find((provider) => provider.provider === "cursor");
    const usable = (cursor?.windows ?? []).filter((window) => window.id === "auto_usage");
    expect(usable[0]?.percentRemaining).toBeGreaterThan(90);
  });

  it("reports a malformed payload instead of throwing", async () => {
    process.env["USAGE_AXI_OPENUSAGE_JSON"] = "/nonexistent/usage-axi.json";
    const load = await loadOpenUsage(false);
    expect(load.ok).toBe(false);
  });
});
