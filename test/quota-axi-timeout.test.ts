import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadQuotaAxi } from "../src/sources/quota-axi.js";

const producer = vi.hoisted(() => ({ elapsedMs: 20_752, exitCode: 0, stdout: "" }));

// Model the child-process deadline without sleeping or invoking a provider.
// The adapter and runCapture remain real; only the OS process boundary is fake.
vi.mock("node:child_process", () => ({
  execFile: vi.fn((
    _file: string,
    _args: string[],
    options: { timeout: number },
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ) => {
    const timedOut = producer.elapsedMs > options.timeout;
    const error = timedOut
      ? Object.assign(new Error("producer deadline exceeded"), { killed: true, signal: "SIGTERM" })
      : producer.exitCode === 0 ? null : Object.assign(new Error("no usable provider data"), { code: producer.exitCode });
    callback(error, producer.stdout, "");
    return {};
  }),
}));

function capture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("USAGE_AXI_QUOTA_AXI_JSON", "");
  vi.stubEnv("USAGE_AXI_QUOTA_AXI_BIN", "quota-axi-test-stub");
  producer.elapsedMs = 20_752;
  producer.exitCode = 0;
  producer.stdout = capture("quota-axi-mac-20260913.json");
});

afterEach(() => vi.unstubAllEnvs());

describe("quota producer deadline", () => {
  it("retains a report arriving after the generic 15-second capture budget", async () => {
    const result = await loadQuotaAxi();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providers.some((provider) => provider.provider === "codex")).toBe(true);
    expect(execFile).toHaveBeenCalledWith(
      "quota-axi-test-stub",
      ["--json", "--no-credential-refresh"],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
  });

  it("still rejects an over-budget child even when stdout already contains valid JSON", async () => {
    producer.elapsedMs = 30_001;
    expect((await loadQuotaAxi()).ok).toBe(false);
  });

  it("retains documented exit-1 unavailable evidence after the generic deadline", async () => {
    producer.exitCode = 1;
    producer.stdout = capture("quota-axi-codex-unavailable-linux.json");
    const result = await loadQuotaAxi();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providers[0]?.state).toEqual(JSON.parse(producer.stdout).providers[0].state);
  });
});
