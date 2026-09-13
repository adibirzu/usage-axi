import { runAxiCli } from "axi-sdk-js";
import { doctorCommand, machineCommand, quotaCommand, sourcesCommand } from "./commands.js";
import { VERSION } from "./version.js";
import { DESCRIPTION } from "./render.js";

export { DESCRIPTION };

export const TOP_HELP = `usage: usage-axi [command] [flags]
commands[4]:
  (none)=quota, machine, sources, doctor
flags[5]:
  --provider <claude,codex,cursor,copilot,grok,kimi,zai,agy,opencode>, --json, --full, --force, --help, -v/--version
examples:
  usage-axi
  usage-axi --json --full
  usage-axi --provider claude,cursor
  usage-axi --force
  usage-axi machine
  usage-axi sources
  usage-axi doctor
`;

export const MACHINE_HELP = `usage: usage-axi machine [flags]
description:
  Report local agents, agent ceiling, 1-minute load per core, memory free percent, and suite slot.
flags[2]:
  --json, --help
examples:
  usage-axi machine
  usage-axi machine --json
`;

export const SOURCES_HELP = `usage: usage-axi sources [flags]
description:
  Report which usage adapter served which data, and how fresh each source is.
flags[2]:
  --json, --help
examples:
  usage-axi sources
  usage-axi sources --json
`;

export const DOCTOR_HELP = `usage: usage-axi doctor [flags]
description:
  Check source availability and contract health; exit 1 when no usage source is available.
flags[2]:
  --json, --help
examples:
  usage-axi doctor
  usage-axi doctor --json
`;

type MainOptions = {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
  binPath?: string;
};

export async function main(options: MainOptions = {}): Promise<void> {
  const binPath = options.binPath ?? process.argv[1] ?? "usage-axi";
  const argv = normalizeArgv(options.argv ?? process.argv.slice(2));

  await runAxiCli<{ binPath: string }>({
    argv,
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    commands: {
      quota: (args, context) => quotaCommand(args, context),
      machine: (args, context) => machineCommand(args, context),
      sources: (args, context) => sourcesCommand(args, context),
      doctor: (args, context) => doctorCommand(args, context),
    },
    // `quota` is the implicit default command; normalizeArgv guarantees the bare
    // home view is never reached, but the SDK contract requires the handler.
    home: (args, context) => quotaCommand(args, context),
    resolveContext: () => ({ binPath }),
    getCommandHelp: (command) => COMMAND_HELP[command],
  });
}

const COMMAND_HELP: Record<string, string> = {
  quota: TOP_HELP,
  machine: MACHINE_HELP,
  sources: SOURCES_HELP,
  doctor: DOCTOR_HELP,
};

/**
 * Route the flag-first default surface onto the `quota` command. `usage-axi`,
 * `usage-axi --json`, and `usage-axi --provider claude` all mean "run quota",
 * but runAxiCli routes on argv[0] and rejects a leading flag. Prefixing the
 * implicit `quota` command name preserves the historical surface while letting
 * the SDK own routing, help, version, and error framing.
 */
export function normalizeArgv(raw: string[]): string[] {
  if (raw.length === 0) return ["quota"];
  if (findLegacyFlag(raw, (arg) => arg === "--help" || arg === "-h") >= 0) {
    return ["--help"];
  }
  const versionIndex = findLegacyFlag(raw, isVersionFlag);
  if (versionIndex >= 0) return [raw[versionIndex]];
  const commandIndex = findCommand(raw);
  if (commandIndex > 0) {
    return [raw[commandIndex], ...raw.slice(0, commandIndex), ...raw.slice(commandIndex + 1)];
  }
  const first = raw[0];
  if (raw.length === 1 && isTopLevelFlag(first)) return raw;
  if (first === "quota" || first === "machine" || first === "sources" || first === "doctor" || first === "update") {
    return raw;
  }
  if (first.startsWith("-")) return ["quota", ...raw];
  return raw;
}

function isTopLevelFlag(flag: string): boolean {
  return flag === "--help" || isVersionFlag(flag);
}

function isVersionFlag(flag: string): boolean {
  return flag === "-v" || flag === "-V" || flag === "--version";
}

function findLegacyFlag(raw: string[], predicate: (arg: string) => boolean): number {
  for (let index = 0; index < raw.length; index++) {
    const arg = raw[index];
    if (arg === "--provider") {
      index++;
      continue;
    }
    if (predicate(arg)) return index;
  }
  return -1;
}

function findCommand(raw: string[]): number {
  for (let index = 0; index < raw.length; index++) {
    const arg = raw[index];
    if (arg === "--provider") {
      index++;
      continue;
    }
    if (arg === "quota" || arg === "machine" || arg === "sources" || arg === "doctor" || arg === "update") {
      return index;
    }
  }
  return -1;
}
