import { AxiError } from "axi-sdk-js";

export type UsageFlags = {
  providers?: string[];
  json: boolean;
  full: boolean;
  force: boolean;
};

const KNOWN_PROVIDERS = new Set([
  "claude",
  "codex",
  "cursor",
  "copilot",
  "grok",
  "kimi",
  "zai",
  "agy",
  "opencode",
]);

const PROVIDER_ALIASES: Record<string, string> = {
  antigravity: "agy",
};

function parseProviders(value: string): string[] {
  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (!tokens.length) {
    throw new AxiError("--provider requires a comma-separated provider list", "VALIDATION_ERROR", [
      "Pass `--provider=claude,cursor` if the value begins with --",
    ]);
  }
  const providers = tokens.map((token) => PROVIDER_ALIASES[token] ?? token);
  const unknown = providers.filter((provider) => !KNOWN_PROVIDERS.has(provider));
  if (unknown.length) {
    throw new AxiError(`unknown provider: ${unknown.join(", ")}`, "VALIDATION_ERROR", [
      "Supported providers: claude, codex, cursor, copilot, grok, kimi, zai, agy, opencode",
    ]);
  }
  return providers;
}

/**
 * Parse the flags shared by every usage-axi command. Command routing is owned
 * by `runAxiCli`; this only interprets the flags that follow.
 */
export function parseFlags(args: string[]): UsageFlags {
  let providerValue: string | undefined;
  let json = false;
  let full = false;
  let force = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--full") {
      full = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--provider") {
      const value = args[index + 1];
      if (!value) {
        throw new AxiError("--provider requires a comma-separated provider list", "VALIDATION_ERROR", [
          "Pass `--provider=...` if the value begins with --",
        ]);
      }
      providerValue = value;
      index++;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      providerValue = arg.slice("--provider=".length);
      continue;
    }
    throw new AxiError(`unknown argument: ${arg}`, "VALIDATION_ERROR", [
      "Run `usage-axi --help` for supported commands and flags",
    ]);
  }

  return {
    ...(providerValue !== undefined ? { providers: parseProviders(providerValue) } : {}),
    json,
    full,
    force,
  };
}
