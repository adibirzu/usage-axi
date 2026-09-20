import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { clearUsageEnv, MACHINE_FIXTURE, missingFixture, tempDir, writeJson } from "./support/harness.js";
import { buildUsage } from "./support/harness.js";

afterEach(clearUsageEnv);

const STAMP = "2026-09-20T09:23:49.595Z";

type Routing = {
  routeFamilies: Array<{
    id: string;
    outcome: { status: string; reason?: string; provider?: string; windows?: string[] };
  }>;
  fallbackPolicies: Array<{
    target: { provider: string; model: string; availability: string };
    onTargetUnavailable: string;
    preserve: string[];
  }>;
};

async function routingFrom(quotaAxi: unknown, models: string[]): Promise<Routing> {
  const { dir, cleanup } = tempDir("usage-axi-routing-");
  try {
    const modelsPath = `${dir}/models.txt`;
    writeFileSync(modelsPath, `${models.join("\n")}\n`);
    const result = await buildUsage({
      USAGE_AXI_OPENUSAGE_JSON: missingFixture(),
      USAGE_AXI_QUOTA_AXI_JSON: writeJson(dir, "quota.json", quotaAxi),
      USAGE_AXI_OPENCODE_MODELS: modelsPath,
      USAGE_AXI_MACHINE_JSON: writeJson(dir, "machine.json", MACHINE_FIXTURE),
    });
    return (result.payload["routing"] ?? {}) as Routing;
  } finally {
    cleanup();
  }
}

describe("OpenCode local-Qwen routing contract", () => {
  it("marks a Go route exhausted from its zero quota window", async () => {
    const routing = await routingFrom(
      {
        generatedAt: STAMP,
        providers: [{
          provider: "opencode",
          plan: "Go",
          state: { status: "fresh", stale: false },
          windows: [{ id: "weekly", percentRemaining: 0 }],
        }],
      },
      ["opencode-go/qwen3.8-flash", "qwen38fn/qwen3.8-flash"],
    );

    expect(routing.routeFamilies).toContainEqual({
      id: "opencode-go",
      outcome: {
        status: "blocked",
        reason: "quota_exhausted",
        provider: "opencode",
        windows: ["weekly"],
        evidence: [{
          source: "quota-axi",
          provider: "opencode",
          stateStatus: "fresh",
          windowId: "weekly",
          percentRemaining: 0,
        }],
      },
    });
  });

  it("marks Zen rate-limit evidence as blocked without conflating it with Go", async () => {
    const routing = await routingFrom(
      {
        generatedAt: STAMP,
        providers: [{
          provider: "opencode",
          plan: "Zen",
          state: { status: "rate_limited", stale: false, error: "OpenCode Zen rate limit reached" },
          windows: [],
        }],
      },
      ["vllm/zen-gpt-5.6-luna", "qwen38fn/qwen3.8-flash"],
    );

    expect(routing.routeFamilies).toContainEqual({
      id: "zen",
      outcome: {
        status: "blocked",
        reason: "rate_limited",
        provider: "opencode",
        windows: [],
        evidence: [{ source: "quota-axi", provider: "opencode", stateStatus: "rate_limited" }],
      },
    });
  });

  it("makes missing local Qwen loud and never names a hosted escalation", async () => {
    const routing = await routingFrom(
      { generatedAt: STAMP, providers: [] },
      ["opencode-go/qwen3.8-flash", "vllm/zen-gpt-5.6-luna"],
    );

    expect(routing.fallbackPolicies).toContainEqual({
      from: [
        { routeFamily: "opencode-go", outcome: "blocked" },
        { routeFamily: "zen", outcome: "blocked" },
      ],
      target: {
        provider: "litellm",
        model: "qwen3.8-flash",
        availability: "unavailable",
        localOnly: true,
      },
      onTargetUnavailable: "fail",
      preserve: ["taskId", "reasoningClass"],
    });
  });
});
