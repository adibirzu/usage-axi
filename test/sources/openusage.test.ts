import { chmodSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_OPENUSAGE_TIMEOUT_MS, loadOpenUsage } from "../../src/sources/openusage.js";
import { clearUsageEnv, fixture, tempDir } from "../support/harness.js";

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

  it("gives a cold openusage read a ceiling well above the old 15s default", () => {
    expect(DEFAULT_OPENUSAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
  });

  it(
    "still parses a cold openusage that takes longer than the old 15s ceiling",
    async () => {
      const { dir, cleanup } = tempDir("usage-axi-openusage-stub-");
      try {
        const stub = `${dir}/openusage-stub.sh`;
        const payload = JSON.stringify({
          generatedAt: "2026-09-13T14:21:24.131Z",
          providers: {
            claude: {
              displayName: "Claude",
              fetchedAt: "2026-09-13T14:20:49.000Z",
              stale: false,
              resources: {
                session: {
                  kind: "consumption",
                  unit: "percent",
                  limit: 100,
                  remaining: 92,
                  used: 8,
                  utilization: 0.08,
                  resetsAt: "2026-09-13T17:00:00.000Z",
                  windowSeconds: 18000,
                },
              },
            },
          },
        });
        writeFileSync(stub, `#!/bin/sh\nsleep 25\nprintf '%s' '${payload}'\n`, { mode: 0o755 });
        chmodSync(stub, 0o755);
        delete process.env["USAGE_AXI_OPENUSAGE_JSON"];
        process.env["USAGE_AXI_OPENUSAGE_BIN"] = stub;

        const started = Date.now();
        const load = await loadOpenUsage(false);
        expect(Date.now() - started).toBeGreaterThanOrEqual(25_000);
        expect(load.ok).toBe(true);
        if (!load.ok) return;
        const claude = load.providers.find((provider) => provider.provider === "claude");
        const session = claude?.windows.find((window) => window.id === "five_hour");
        expect(session?.percentRemaining).toBe(92);
      } finally {
        cleanup();
      }
    },
    45_000,
  );
});
