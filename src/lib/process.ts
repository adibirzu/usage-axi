import { execFile } from "node:child_process";

export type CaptureResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: string };

/**
 * Run one command and capture stdout. Never throws: a missing binary, a
 * non-zero exit, or a timeout is reported as `{ ok: false, reason }` so an
 * adapter can fail that source without taking the whole report down.
 */
export function runCapture(
  file: string,
  args: string[],
  options: { timeoutMs?: number; includeStderr?: boolean } = {},
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 15000,
        maxBuffer: 8 * 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const reason =
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? `${file} is not installed`
              : error.message;
          resolve({ ok: false, reason });
          return;
        }
        // Some macOS tools (`memory_pressure`) report on stderr; callers that
        // parse a human report opt in to a merged stream.
        resolve({ ok: true, stdout: options.includeStderr ? `${stdout}${stderr}` : stdout });
      },
    );
  });
}
