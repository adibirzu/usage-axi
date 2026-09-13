import { afterEach, describe, expect, it } from "vitest";
import { main, normalizeArgv } from "../src/cli.js";
import {
  MACHINE_FIXTURE,
  clearUsageEnv,
  fixture,
  loadMachineSnapshot,
  missingFixture,
  tempDir,
  writeJson,
} from "./support/harness.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

afterEach(() => {
  clearUsageEnv();
  process.exitCode = 0;
});

async function runCli(argv: string[]): Promise<string> {
  let output = "";
  await main({ argv, stdout: { write: (chunk: string) => (output += chunk) } });
  return output;
}

function selectorsEnv(): Record<string, string> {
  const { dir } = tempDir("usage-axi-cli-");
  return {
    USAGE_AXI_OPENUSAGE_JSON: fixture("openusage-mac-20260913.json"),
    USAGE_AXI_QUOTA_AXI_JSON: fixture("quota-axi-mac-20260913.json"),
    USAGE_AXI_OPENCODE_MODELS: fixture("opencode-models-mac-20260913.txt"),
    USAGE_AXI_MACHINE_JSON: writeJson(dir, "machine.json", MACHINE_FIXTURE),
  };
}

describe("normalizeArgv", () => {
  it("routes a bare invocation and leading flags to the quota default", () => {
    expect(normalizeArgv([])).toEqual(["quota"]);
    expect(normalizeArgv(["--json"])).toEqual(["quota", "--json"]);
    expect(normalizeArgv(["--provider", "claude,cursor"])).toEqual(["quota", "--provider", "claude,cursor"]);
    expect(normalizeArgv(["machine"])).toEqual(["machine"]);
    expect(normalizeArgv(["--json", "doctor"])).toEqual(["doctor", "--json"]);
    expect(normalizeArgv(["update", "--check"])).toEqual(["update", "--check"]);
  });
});

describe("quota command", () => {
  it("emits TOON content by default with help next steps", async () => {
    Object.assign(process.env, selectorsEnv());
    const output = await runCli([]);
    expect(output).toContain("providers[");
    expect(output).toContain("windows[");
    expect(output).toContain("machine");
    expect(output).toContain("help[");
  });

  it("emits the 15 selector fields in default --json without --full", async () => {
    Object.assign(process.env, selectorsEnv());
    const payload = JSON.parse(await runCli(["--json"]));
    expect(payload.generatedAt).toBeTypeOf("string");
    expect(Array.isArray(payload.providers)).toBe(true);

    const provider = payload.providers.find((item: { provider: string }) => item.provider === "claude");
    expect(provider.state.status).toBe("fresh");
    expect(provider.state.stale).toBe(false);
    expect(provider.windows.every((window: { id?: unknown }) => typeof window.id === "string")).toBe(true);
    expect(provider.windows.some((window: { percentRemaining?: unknown }) => typeof window.percentRemaining === "number")).toBe(true);
    const availability = provider.quotaSemantics.effectiveAvailability[0];
    expect(availability.status).toBe("known");
    expect(availability.effectivePercentRemaining).toBe(23);
    expect(availability.scope).toBe("all_models");
    expect(Array.isArray(availability.boundedBy)).toBe(true);
    expect(Array.isArray(availability.limitingWindowIds)).toBe(true);
    expect(availability.selection.status).toBe("known");
    expect(availability.selection.spendPriority).toBeCloseTo(-2.8739, 4);

    // No account identity or credentials ever leave usage-axi.
    expect(JSON.stringify(payload)).not.toContain("accountId");
    expect(JSON.stringify(payload)).not.toContain("REDACTED");
  });

  it("adds provenance attempts only with --full", async () => {
    Object.assign(process.env, selectorsEnv());
    const lean = JSON.parse(await runCli(["--json"]));
    expect(lean.providers.every((item: Record<string, unknown>) => item.attempts === undefined)).toBe(true);
    const full = JSON.parse(await runCli(["--json", "--full"]));
    expect(full.providers.some((item: Record<string, unknown>) => Array.isArray(item.attempts))).toBe(true);
  });

  it("scopes providers with --provider", async () => {
    Object.assign(process.env, selectorsEnv());
    const payload = JSON.parse(await runCli(["--json", "--provider", "claude"]));
    expect(payload.providers.map((item: { provider: string }) => item.provider)).toEqual(["claude"]);
  });

  it("rejects an unknown provider as a validation error", async () => {
    Object.assign(process.env, selectorsEnv());
    const output = await runCli(["--provider", "nope"]);
    expect(output).toContain("unknown provider");
    expect(process.exitCode).toBe(2);
  });
});

describe("machine, sources, doctor", () => {
  it("reports machine capacity", async () => {
    Object.assign(process.env, selectorsEnv());
    const payload = JSON.parse(await runCli(["machine", "--json"]));
    expect(payload.machine.agentCeiling).toBe(10);
    expect(payload.machine.memoryFreePct).toBe(58.9);
  });

  it("prints the counted roots for a replayed ps snapshot", async () => {
    const snapshot = loadMachineSnapshot("adi1-20260913");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    const { dir } = tempDir("usage-axi-cli-machine-");
    const commPath = join(dir, "comm.ps");
    const argvPath = join(dir, "argv.ps");
    writeFileSync(commPath, snapshot.comm);
    writeFileSync(argvPath, snapshot.argv);
    process.env["USAGE_AXI_MACHINE_PS_COMM"] = commPath;
    process.env["USAGE_AXI_MACHINE_PS_ARGV"] = argvPath;
    const payload = JSON.parse(await runCli(["machine", "--json"]));
    expect(payload.machine.agents).toBe(snapshot.meta.golden.agents);
    expect(payload.machine.roots).toHaveLength(snapshot.meta.golden.agents);
    expect(payload.machine.roots[0]).toEqual(
      expect.objectContaining({ pid: expect.any(Number), comm: expect.any(String), match: expect.any(String) }),
    );
  });

  it("reports source provenance", async () => {
    Object.assign(process.env, selectorsEnv());
    const payload = JSON.parse(await runCli(["sources", "--json"]));
    const names = payload.sources.map((source: { source: string }) => source.source);
    expect(names).toEqual(["openusage", "quota-axi", "opencode-catalog", "machine"]);
  });

  it("reports doctor checks and fails when no source is available", async () => {
    Object.assign(process.env, selectorsEnv());
    const healthy = JSON.parse(await runCli(["doctor", "--json"]));
    expect(healthy.checks.find((check: { check: string }) => check.check === "usage-source").status).toBe("ok");

    clearUsageEnv();
    process.env["USAGE_AXI_OPENUSAGE_JSON"] = missingFixture();
    process.env["USAGE_AXI_QUOTA_AXI_JSON"] = missingFixture();
    process.env["USAGE_AXI_OPENCODE_MODELS"] = missingFixture();
    await runCli(["doctor", "--json"]);
    expect(process.exitCode).toBe(1);
  });
});
