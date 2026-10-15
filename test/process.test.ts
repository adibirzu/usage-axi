import { describe, expect, it } from "vitest";
import { runCapture } from "../src/lib/process.js";

describe("documented nonzero captures", () => {
  it("keeps nonzero exits failed unless a caller explicitly accepts them", async () => {
    const args = ["-e", 'process.stdout.write("report"); process.exitCode = 1'];
    expect((await runCapture(process.execPath, args)).ok).toBe(false);
    expect(await runCapture(process.execPath, args, { acceptedExitCodes: [1] })).toEqual({
      ok: true,
      stdout: "report",
    });
  });

  it("does not accept a signalled child that already wrote output", async () => {
    const result = await runCapture(process.execPath, ["-e", 'process.stdout.write("report"); process.kill(process.pid, "SIGTERM")'], {
      acceptedExitCodes: [1],
    });
    expect(result.ok).toBe(false);
  });

  it("does not accept a timed-out child that already wrote output", async () => {
    const result = await runCapture(process.execPath, ["-e", 'process.stdout.write("report"); setInterval(() => {}, 1000)'], {
      acceptedExitCodes: [1],
      timeoutMs: 500,
    });
    expect(result.ok).toBe(false);
  });
});
