import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { loadQuotaAxi } from "../src/sources/quota-axi.js";
import {
  MACHINE_FIXTURE,
  clearUsageEnv,
  epochOf,
  fixture,
  missingFixture,
  runSelector,
  tempDir,
  writeJson,
} from "./support/harness.js";

afterEach(() => {
  clearUsageEnv();
  process.exitCode = 0;
});

function unavailableCapture() {
  return JSON.parse(readFileSync(fixture("quota-axi-codex-unavailable-linux.json"), "utf8"));
}

function genuineCapture() {
  const capture = JSON.parse(readFileSync(fixture("quota-axi-mac-20260913.json"), "utf8"));
  capture.providers = capture.providers.filter((provider: { provider: string }) => provider.provider === "codex");
  return capture;
}

/** Real child-process boundary; the marker models an undesired renewal attempt. */
function quotaExecutable(dir: string, payload: unknown, exitCode: number) {
  const binary = join(dir, "quota-axi.mjs");
  const renewal = join(dir, "renewal-attempted");
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (!process.argv.includes("--json")) process.exit(2);
if (!process.argv.includes("--no-credential-refresh")) {
  writeFileSync(${JSON.stringify(renewal)}, "renewal attempted");
}
process.stdout.write(${JSON.stringify(text)});
process.exitCode = ${exitCode};
`, { mode: 0o755 });
  return { binary, renewal };
}

async function runQuota(dir: string, binary: string) {
  Object.assign(process.env, {
    USAGE_AXI_QUOTA_AXI_BIN: binary,
    USAGE_AXI_OPENUSAGE_JSON: missingFixture(),
    USAGE_AXI_OPENCODE_MODELS: missingFixture(),
    USAGE_AXI_MACHINE_JSON: writeJson(dir, "machine.json", MACHINE_FIXTURE),
  });
  let output = "";
  await main({ argv: ["--json", "--full"], stdout: { write: (chunk: string) => (output += chunk) } });
  return JSON.parse(output);
}

describe("quota-axi executable integration", () => {
  it("reads genuine captured windows without attempting credential renewal", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const capture = genuineCapture();
      const { binary, renewal } = quotaExecutable(dir, capture, 0);
      const payload = await runQuota(dir, binary);
      expect(existsSync(renewal)).toBe(false);
      expect(payload.providers[0].windows).toEqual(capture.providers[0].windows);
      expect(payload.providers[0].state).toEqual(capture.providers[0].state);
      expect(JSON.stringify(payload)).not.toContain("accountId");
      expect(JSON.stringify(payload)).not.toContain("REDACTED");
      const selected = await runSelector(writeJson(dir, "usage.json", payload), [{ harness: "codex" }], epochOf(capture.generatedAt));
      expect(selected.code).toBe(0);
      expect(JSON.parse(selected.stdout).harness).toBe("codex");
    } finally {
      cleanup();
    }
  });

  it("preserves the observed Linux unavailable provider and refuses it on exit 1", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const capture = unavailableCapture();
      const { binary, renewal } = quotaExecutable(dir, capture, 1);
      const payload = await runQuota(dir, binary);
      expect(existsSync(renewal)).toBe(false);
      expect(payload.providers).toHaveLength(1);
      expect(payload.providers[0].windows).toEqual([]);
      expect(payload.providers[0].state).toEqual(capture.providers[0].state);
      expect(payload.providers[0].attempts).toEqual(capture.providers[0].attempts);
      expect(payload.providers[0].quotaSemantics.status).toBe("unknown");
      expect(payload.sources.find((source: { source: string }) => source.source === "quota-axi").status).toBe("available");
      expect(process.exitCode).toBe(1);
      const selected = await runSelector(writeJson(dir, "usage.json", payload), [{ harness: "codex" }], epochOf(capture.generatedAt));
      expect(selected.code).toBe(3);
      expect(selected.stderr).toContain("provider telemetry not fresh");
    } finally {
      cleanup();
    }
  });

  it.each([
    ["expired sign-in", "auth_required", false, "Codex sign-in required"],
    ["rate limit", "rate_limited", false, "Codex quota endpoint rate limited"],
  ])("keeps %s distinct from unknown capacity on exit 1", async (_name, status, stale, error) => {
    const { dir, cleanup } = tempDir();
    try {
      const capture = unavailableCapture();
      capture.providers[0].state = { status, stale, error };
      const { binary } = quotaExecutable(dir, capture, 1);
      const payload = await runQuota(dir, binary);
      expect(payload.providers[0].state).toEqual(capture.providers[0].state);
      expect(payload.providers[0].windows).toEqual([]);
      const selected = await runSelector(writeJson(dir, "usage.json", payload), [{ harness: "codex" }], epochOf(capture.generatedAt));
      expect(selected.code).toBe(3);
    } finally {
      cleanup();
    }
  });

  it.each(["stale provider", "expired telemetry", "exhausted quota"])("still refuses %s with captured windows", async (scenario) => {
    const { dir, cleanup } = tempDir();
    try {
      const capture = genuineCapture();
      const provider = capture.providers[0];
      if (scenario === "stale provider") provider.state = { status: "stale", stale: true };
      if (scenario === "exhausted quota") {
        provider.windows = provider.windows.map((window: object) => ({ ...window, percentRemaining: 0, percentUsed: 100 }));
        delete provider.quotaSemantics;
      }
      const { binary } = quotaExecutable(dir, capture, 0);
      const payload = await runQuota(dir, binary);
      expect(payload.providers[0].state).toEqual(provider.state);
      expect(payload.providers[0].windows).toEqual(provider.windows);
      const now = epochOf(capture.generatedAt) + (scenario === "expired telemetry" ? 400 : 0);
      const selected = await runSelector(writeJson(dir, "usage.json", payload), [{ harness: "codex" }], now);
      expect(selected.code).toBe(3);
      expect(selected.stderr).toContain(scenario === "expired telemetry" ? "stale or undated" : scenario === "stale provider" ? "not fresh" : "reserve");
    } finally {
      cleanup();
    }
  });

  it.each(["not JSON", "{}", '{"providers":null}'])("rejects malformed exit-1 output: %s", async (text) => {
    const { dir, cleanup } = tempDir();
    try {
      const { binary } = quotaExecutable(dir, text, 1);
      process.env["USAGE_AXI_QUOTA_AXI_BIN"] = binary;
      expect(await loadQuotaAxi()).toEqual({ ok: false, reason: "quota-axi payload malformed" });
    } finally {
      cleanup();
    }
  });

  it("rejects a usage-error exit even when stdout contains valid quota JSON", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { binary } = quotaExecutable(dir, genuineCapture(), 2);
      process.env["USAGE_AXI_QUOTA_AXI_BIN"] = binary;
      expect((await loadQuotaAxi()).ok).toBe(false);
    } finally {
      cleanup();
    }
  });
});
