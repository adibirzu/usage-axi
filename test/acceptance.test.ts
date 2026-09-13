/**
 * The 12 usage-axi acceptance fixtures U1-U12 from the P0 contracts
 * (data/axi-p0-contracts/contracts.md section 6A). Each one builds the exact
 * `usage-axi --json --full` payload for its source capture and hands it to the
 * pinned firstmate selector `fm-dispatch-select.mjs select --quota-json`,
 * asserting the selector accepts usage-axi's output unchanged.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  MACHINE_FIXTURE,
  buildUsage,
  clearUsageEnv,
  epochOf,
  fixture,
  macUsage,
  missingFixture,
  runSelector,
  tempDir,
  writeJson,
} from "./support/harness.js";

afterEach(clearUsageEnv);

const STAMP = "1970-01-01T00:16:40.000Z";
const NOW = 1000;

type Payload = Record<string, unknown>;

async function usageFromQuotaAxi(quotaAxi: unknown, full = true): Promise<Payload> {
  const { dir, cleanup } = tempDir();
  try {
    const { payload } = await buildUsage(
      {
        USAGE_AXI_OPENUSAGE_JSON: missingFixture(),
        USAGE_AXI_QUOTA_AXI_JSON: writeJson(dir, "quota-axi.json", quotaAxi),
        USAGE_AXI_OPENCODE_MODELS: missingFixture(),
        USAGE_AXI_MACHINE_JSON: writeJson(dir, "machine.json", MACHINE_FIXTURE),
      },
      full,
    );
    return payload;
  } finally {
    cleanup();
  }
}

async function usageFromOpenUsage(openusagePath: string): Promise<Payload> {
  const { dir, cleanup } = tempDir();
  try {
    const { payload } = await buildUsage(
      {
        USAGE_AXI_OPENUSAGE_JSON: openusagePath,
        USAGE_AXI_QUOTA_AXI_JSON: missingFixture(),
        USAGE_AXI_OPENCODE_MODELS: missingFixture(),
        USAGE_AXI_MACHINE_JSON: writeJson(dir, "machine.json", MACHINE_FIXTURE),
      },
      true,
    );
    return payload;
  } finally {
    cleanup();
  }
}

async function withPayload<T>(payload: Payload, fn: (file: string) => Promise<T>): Promise<T> {
  const { dir, cleanup } = tempDir();
  try {
    return await fn(writeJson(dir, "usage.json", payload));
  } finally {
    cleanup();
  }
}

function parse(stdout: string): Record<string, string> {
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
  return JSON.parse(line) as Record<string, string>;
}

describe("U1: usage-axi output accepted by the selector", () => {
  it("selects between claude and codex from the minimal capture", async () => {
    const payload = await usageFromQuotaAxi(JSON.parse(readFileSync(fixture("selector-minimal.quota.json"), "utf8")));
    await withPayload(payload, async (file) => {
      const result = await runSelector(file, [{ harness: "claude" }, { harness: "codex" }], NOW);
      expect(result.code).toBe(0);
      expect(["claude", "codex"]).toContain(parse(result.stdout).harness);
    });
  });

  it("selects between claude and codex from the Mac capture", async () => {
    const { payload, response } = await macUsage(true);
    const now = epochOf(response.generatedAt);
    await withPayload(payload, async (file) => {
      const result = await runSelector(file, [{ harness: "claude" }, { harness: "codex" }], now);
      expect(result.code).toBe(0);
      expect(["claude", "codex"]).toContain(parse(result.stdout).harness);
    });
  });
});

describe("U2: staleness gate", () => {
  it("refuses telemetry older than the max age", async () => {
    const { payload, response } = await macUsage(true);
    await withPayload(payload, async (file) => {
      const result = await runSelector(file, [{ harness: "claude" }], epochOf(response.generatedAt) + 400);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("stale or undated");
    });
  });
});

describe("U3: windowless provider with aggregate availability", () => {
  it("refuses a fresh provider with no usable live window", async () => {
    const payload = await usageFromQuotaAxi({
      schemaVersion: 5,
      generatedAt: STAMP,
      providers: [
        {
          provider: "claude",
          state: { status: "fresh", stale: false },
          windows: [],
          quotaSemantics: {
            status: "known",
            effectiveAvailability: [
              { scope: "all_models", status: "known", effectivePercentRemaining: 90 },
            ],
          },
        },
      ],
    });
    await withPayload(payload, async (file) => {
      const result = await runSelector(file, [{ harness: "claude" }], NOW);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("no usable live window percentage");
    });
  });
});

const CURSOR_SPLIT = () => JSON.parse(readFileSync(fixture("cursor-split-pools.quota.json"), "utf8"));

describe("U4-U6: cursor split pools", () => {
  it("U4 refuses undeclared cursor on its provider-wide minimum", async () => {
    const payload = await usageFromQuotaAxi(CURSOR_SPLIT());
    await withPayload(payload, async (file) => {
      const result = await runSelector(file, [{ harness: "cursor" }], NOW);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("quota headroom 0% is at or below 20% reserve");
    });
  });

  it("U5 prices a declared healthy auto_usage window", async () => {
    const payload = await usageFromQuotaAxi(CURSOR_SPLIT());
    await withPayload(payload, async (file) => {
      const result = await runSelector(
        file,
        [{ harness: "cursor", model: "cursor-grok-4.6-high", quotaWindow: "auto_usage" }],
        NOW,
      );
      expect(result.code).toBe(0);
      expect(parse(result.stdout).model).toBe("cursor-grok-4.6-high");
      expect(result.stderr).toContain("window auto_usage headroom=99%");
    });
  });

  it("U6 still refuses a declared exhausted api_usage window", async () => {
    const payload = await usageFromQuotaAxi(CURSOR_SPLIT());
    await withPayload(payload, async (file) => {
      const result = await runSelector(file, [{ harness: "cursor", quotaWindow: "api_usage" }], NOW);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("window api_usage headroom 0% is at or below 20% reserve");
    });
  });
});

describe("U7: quota-axi schemaVersion 5 parses", () => {
  it("accepts the adi1 capture and still refuses undeclared cursor", async () => {
    const payload = await usageFromQuotaAxi(JSON.parse(readFileSync(fixture("quota-axi.adi1.json"), "utf8")));
    await withPayload(payload, async (file) => {
      const undeclared = await runSelector(file, [{ harness: "cursor" }], epochOf("2026-09-13T13:08:20.753Z"));
      expect(undeclared.stderr).not.toContain("malformed");
      expect(undeclared.code).toBe(3);
      expect(undeclared.stderr).toContain("at or below 20% reserve");
    });
  });
});

describe("U8: OpenUsage mapping prices cursor Auto, not API zero", () => {
  it("prices a declared auto_usage window from the OpenUsage capture", async () => {
    const payload = await usageFromOpenUsage(fixture("openusage-mac-20260913.json"));
    await withPayload(payload, async (file) => {
      const undeclared = await runSelector(file, [{ harness: "cursor" }], epochOf("2026-09-13T13:20:21.043Z"));
      expect(undeclared.code).toBe(3);
      const declared = await runSelector(
        file,
        [{ harness: "cursor", quotaWindow: "auto_usage" }],
        epochOf("2026-09-13T13:20:21.043Z"),
      );
      expect(declared.code).toBe(0);
      expect(declared.stderr).toContain("window auto_usage headroom=99.15555555555555%");
    });
  });
});

describe("U9: additive machine/pools/source keys are accepted", () => {
  it("emits machine, pools, and source while the selector ignores them", async () => {
    const { payload, response } = await macUsage(true);
    expect(payload["machine"]).toBeDefined();
    const providers = payload["providers"] as Array<Record<string, unknown>>;
    expect(providers.every((provider) => typeof provider["source"] === "string")).toBe(true);
    expect(providers.some((provider) => Array.isArray(provider["pools"]))).toBe(true);
    await withPayload(payload, async (file) => {
      const result = await runSelector(file, [{ harness: "claude" }], epochOf(response.generatedAt));
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("malformed");
      // OpenUsage is primary, so the cursor Auto percentage comes from it.
      const cursor = response.providers.find((provider) => provider.provider === "cursor");
      expect(cursor?.windows.find((window) => window.id === "auto_usage")?.percentRemaining).toBeCloseTo(99.1555, 3);
    });
  });
});

describe("U10: agy pools price separately", () => {
  it("prices declared gemini and claude_gpt windows independently", async () => {
    const payload = await usageFromQuotaAxi({
      schemaVersion: 5,
      generatedAt: STAMP,
      providers: [
        {
          provider: "agy",
          state: { status: "fresh", stale: false },
          windows: [
            { id: "gemini_5h", percentRemaining: 100 },
            { id: "gemini_weekly", percentRemaining: 93 },
            { id: "claude_gpt_5h", percentRemaining: 0 },
            { id: "claude_gpt_weekly", percentRemaining: 32 },
          ],
          quotaSemantics: { status: "known", effectiveAvailability: [] },
        },
      ],
    });
    await withPayload(payload, async (file) => {
      const undeclared = await runSelector(file, [{ harness: "agy" }], NOW);
      expect(undeclared.code).toBe(3);
      const gemini = await runSelector(file, [{ harness: "agy", quotaWindow: "gemini_5h" }], NOW);
      expect(gemini.code).toBe(0);
      const claude = await runSelector(file, [{ harness: "agy", quotaWindow: "claude_gpt_5h" }], NOW);
      expect(claude.code).toBe(3);
      expect(claude.stderr).toContain("window claude_gpt_5h headroom 0% is at or below 20% reserve");
    });
  });
});

describe("U11: spendPriority ranks above headroom", () => {
  it("keeps the quota-axi spendPriority scalar through the pass-through", async () => {
    const payload = await usageFromQuotaAxi({
      schemaVersion: 5,
      generatedAt: STAMP,
      providers: [
        {
          provider: "claude",
          state: { status: "fresh", stale: false },
          windows: [{ id: "all", percentRemaining: 80 }],
          quotaSemantics: {
            status: "known",
            effectiveAvailability: [
              {
                scope: "all_models",
                status: "known",
                effectivePercentRemaining: 80,
                selection: { status: "known", spendPriority: -1.1111 },
              },
            ],
          },
        },
        {
          provider: "codex",
          state: { status: "fresh", stale: false },
          windows: [{ id: "all", percentRemaining: 40 }],
          quotaSemantics: {
            status: "known",
            effectiveAvailability: [
              {
                scope: "all_models",
                status: "known",
                effectivePercentRemaining: 40,
                selection: { status: "known", spendPriority: -0.8333 },
              },
            ],
          },
        },
      ],
    });
    await withPayload(payload, async (file) => {
      const result = await runSelector(
        file,
        [{ harness: "claude", model: "sonnet" }, { harness: "codex", model: "gpt" }],
        NOW,
      );
      expect(result.code).toBe(0);
      expect(parse(result.stdout).harness).toBe("codex");
    });
  });
});

type PayloadProvider = {
  provider: string;
  source: string;
  windows: Array<{ id: string; percentRemaining?: number }>;
};

const LIVE_MAC = () => fixture("usage-axi-live-mac-20260913T1421.json");
const LIVE_NOW = epochOf("2026-09-13T14:21:24.131Z");
const LIVE_MAC_PR3 = () => fixture("usage-axi-live-mac-pr3-20260913T1450.json");
const LIVE_PR3_NOW = epochOf("2026-09-13T14:53:18.784Z");

describe("U13: live Mac 14:21 capture — selector verdicts", () => {
  it("prices the declared cursor auto_usage window and refuses its provider-wide zero", async () => {
    const declared = await runSelector(LIVE_MAC(), [{ harness: "cursor", quotaWindow: "auto_usage" }], LIVE_NOW);
    expect(declared.code).toBe(0);
    expect(declared.stderr).toContain("window auto_usage headroom=99.15555555555555%");

    // The smallest counterfactual: nothing else changes, only the declared
    // window is dropped, and the api_usage 0% minimum takes over.
    const wide = await runSelector(LIVE_MAC(), [{ harness: "cursor" }], LIVE_NOW);
    expect(wide.code).toBe(3);
    expect(wide.stderr).toContain("quota headroom 0% is at or below 20% reserve");
  });

  it("selects grok and agy, and refuses the captured empty claude", async () => {
    const grok = await runSelector(LIVE_MAC(), [{ harness: "grok" }], LIVE_NOW);
    expect(grok.code).toBe(0);
    const agy = await runSelector(LIVE_MAC(), [{ harness: "agy", quotaWindow: "gemini_5h" }], LIVE_NOW);
    expect(agy.code).toBe(0);

    const claude = await runSelector(LIVE_MAC(), [{ harness: "claude" }], LIVE_NOW);
    expect(claude.code).toBe(3);
    expect(claude.stderr).toContain("no usable live window percentage");
  });

  it("refuses opencode-go: the selector has no opencode provider identity", async () => {
    const result = await runSelector(
      LIVE_MAC(),
      [{ harness: "opencode", provider: "opencode", model: "opencode-go/deepseek-v4.1-flash" }],
      LIVE_NOW,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("provider identity is unresolved or unsupported for harness opencode");
  });
});

describe("U14: an empty OpenUsage provider no longer shadows quota-axi", () => {
  it("fills claude five_hour/seven_day/model:fable from quota-axi and selects it", async () => {
    const raw = JSON.parse(readFileSync(fixture("openusage-mac-20260913.json"), "utf8")) as {
      providers: Record<string, { resources?: Record<string, unknown> }>;
    };
    raw.providers["claude"]!.resources = {};
    const { dir, cleanup } = tempDir();
    try {
      const { payload } = await buildUsage({
        USAGE_AXI_OPENUSAGE_JSON: writeJson(dir, "openusage-empty-claude.json", raw),
        USAGE_AXI_QUOTA_AXI_JSON: fixture("quota-axi-mac-20260913.json"),
        USAGE_AXI_OPENCODE_MODELS: missingFixture(),
        USAGE_AXI_MACHINE_JSON: writeJson(dir, "machine.json", MACHINE_FIXTURE),
      });
      const providers = payload["providers"] as PayloadProvider[];
      const claude = providers.find((provider) => provider.provider === "claude");
      expect(claude?.source).toBe("quota-axi");
      expect(claude?.windows.map((window) => window.id).sort()).toEqual([
        "five_hour",
        "model:fable",
        "seven_day",
      ]);
      expect(claude?.windows.find((window) => window.id === "five_hour")?.percentRemaining).toBe(92);
      expect(claude?.windows.find((window) => window.id === "seven_day")?.percentRemaining).toBe(23);
      expect(claude?.windows.find((window) => window.id === "model:fable")?.percentRemaining).toBe(65);

      await withPayload(payload, async (file) => {
        const result = await runSelector(file, [{ harness: "claude" }], epochOf(payload["generatedAt"] as string));
        expect(result.code).toBe(0);
        expect(parse(result.stdout).harness).toBe("claude");
      });
    } finally {
      cleanup();
    }
  });
});

describe("U15: a failed OpenUsage is visible, not swallowed", () => {
  it("carries an openusage sources[] error while quota-axi still reports", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { payload } = await buildUsage({
        USAGE_AXI_OPENUSAGE_JSON: missingFixture(),
        USAGE_AXI_QUOTA_AXI_JSON: fixture("quota-axi-mac-20260913.json"),
        USAGE_AXI_OPENCODE_MODELS: missingFixture(),
        USAGE_AXI_MACHINE_JSON: writeJson(dir, "machine.json", MACHINE_FIXTURE),
      });
      const sources = payload["sources"] as Array<{ source: string; status: string; detail: string }>;
      const openusage = sources.find((source) => source.source === "openusage");
      expect(openusage?.status).toBe("unavailable");
      expect(openusage?.detail).toContain("openusage");
      expect((payload["providers"] as PayloadProvider[]).length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});

describe("U12: grok usable auth with no window is not capacity", () => {
  it("never prices a windowless grok against a healthy candidate", async () => {
    const payload = await usageFromQuotaAxi({
      schemaVersion: 5,
      generatedAt: STAMP,
      providers: [
        {
          provider: "claude",
          state: { status: "fresh", stale: false },
          windows: [{ id: "all", percentRemaining: 80 }],
        },
        {
          provider: "grok",
          source: "unavailable",
          windows: [],
          state: { status: "error", stale: false, error: "Grok quota unavailable", authStatus: "usable" },
        },
      ],
    });
    await withPayload(payload, async (file) => {
      const mixed = await runSelector(
        file,
        [{ harness: "claude", model: "sonnet" }, { harness: "grok" }],
        NOW,
      );
      expect(parse(mixed.stdout).harness).toBe("claude");
      const alone = await runSelector(file, [{ harness: "grok" }, { harness: "grok" }], NOW);
      expect(alone.code).not.toBe(0);
    });
  });
});

describe("U16: live Mac PR3 capture — the five selector proofs", () => {
  it("chooses claude, cursor auto_usage and agy, refuses opencode, and shows the captured stale grok", async () => {
    const claude = await runSelector(LIVE_MAC_PR3(), [{ harness: "claude" }], LIVE_PR3_NOW);
    expect(claude.code).toBe(0);
    expect(claude.stderr).toContain("headroom=22%");

    const cursor = await runSelector(
      LIVE_MAC_PR3(),
      [{ harness: "cursor", quotaWindow: "auto_usage" }],
      LIVE_PR3_NOW,
    );
    expect(cursor.code).toBe(0);
    expect(cursor.stderr).toContain("window auto_usage headroom=99.15555555555555%");

    const agy = await runSelector(LIVE_MAC_PR3(), [{ harness: "agy", quotaWindow: "gemini_5h" }], LIVE_PR3_NOW);
    expect(agy.code).toBe(0);
    expect(agy.stderr).toContain("window gemini_5h headroom=99%");

    const opencode = await runSelector(
      LIVE_MAC_PR3(),
      [{ harness: "opencode", provider: "opencode", model: "opencode-go/deepseek-v4.1-flash" }],
      LIVE_PR3_NOW,
    );
    expect(opencode.code).toBe(2);
    expect(opencode.stderr).toContain("provider identity is unresolved or unsupported for harness opencode");

    // The captured failure: OpenUsage's cache-TTL stale flag reached the
    // contract, so grok was refused even though its window was 100% remaining.
    const grok = await runSelector(LIVE_MAC_PR3(), [{ harness: "grok" }], LIVE_PR3_NOW);
    expect(grok.code).toBe(3);
    expect(grok.stderr).toContain("provider telemetry not fresh");
  });

  it("proves the counterfactual: flipping only state.stale/status makes grok choose", async () => {
    const raw = JSON.parse(readFileSync(LIVE_MAC_PR3(), "utf8")) as {
      providers: Array<{ provider: string; state: { status: string; stale: boolean } }>;
    };
    const grok = raw.providers.find((provider) => provider.provider === "grok");
    if (!grok) throw new Error("expected grok in the PR3 capture");
    grok.state.status = "fresh";
    grok.state.stale = false;

    await withPayload(raw as Payload, async (file) => {
      const result = await runSelector(file, [{ harness: "grok" }], LIVE_PR3_NOW);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("headroom=100%");
    });
  });
});

describe("U17: a cache-expired OpenUsage grok no longer reaches the selector as stale", () => {
  it("maps the stale upstream flag to cacheStale and chooses grok at 100%", async () => {
    const { dir, cleanup } = tempDir();
    try {
      // Derived from the PR3 capture's grok window (credits 100%, resets
      // 2026-09-15) with the upstream cache flag the CLI reported.
      const raw = {
        generatedAt: "2026-09-13T14:53:18.784Z",
        providers: {
          grok: {
            displayName: "Grok",
            stale: true,
            fetchedAt: "2026-09-13T14:48:15.000Z",
            resources: {
              weekly: {
                kind: "consumption",
                unit: "percent",
                limit: 100,
                remaining: 100,
                used: 0,
                utilization: 0,
                resetsAt: "2026-09-15T00:00:00.000Z",
                windowSeconds: 604800,
              },
            },
          },
        },
      };
      const { payload } = await buildUsage({
        USAGE_AXI_OPENUSAGE_JSON: writeJson(dir, "openusage-stale-grok.json", raw),
        USAGE_AXI_QUOTA_AXI_JSON: missingFixture(),
        USAGE_AXI_OPENCODE_MODELS: missingFixture(),
        USAGE_AXI_MACHINE_JSON: writeJson(dir, "machine.json", MACHINE_FIXTURE),
      });
      const grok = (payload["providers"] as Array<Record<string, unknown>>).find(
        (provider) => provider["provider"] === "grok",
      );
      const state = grok?.["state"] as { status: string; stale: boolean; cacheStale?: boolean };
      expect(state.status).toBe("fresh");
      expect(state.stale).toBe(false);
      expect(state.cacheStale).toBe(true);

      await withPayload(payload, async (file) => {
        const result = await runSelector(file, [{ harness: "grok" }], epochOf(raw.generatedAt));
        expect(result.code).toBe(0);
        expect(result.stderr).toContain("headroom=100%");
      });
    } finally {
      cleanup();
    }
  });
});
