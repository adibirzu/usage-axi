import { DESCRIPTION, DOCTOR_HELP, MACHINE_HELP, SOURCES_HELP, TOP_HELP } from "./cli.js";

// Trigger string agents match against to auto-load the skill. Kept terse and
// outcome-focused so it fires on "check usage / quota / capacity" intents.
export const SKILL_DESCRIPTION =
  "One truthful picture of every subscription, free pool, and local machine capacity via the usage-axi CLI - " +
  "OpenUsage first, quota-axi as a fallback, opencode model pools, and machine headroom, in the quota-axi JSON " +
  "contract routing agents already consume. Use before deciding whether a provider has headroom, when the user " +
  "asks about usage, rate limits, remaining quota, or whether the machine can take another agent.";

export const SKILL_AUTHOR = "Adrian Birzu";

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

/** Render the installable SKILL.md for the usage-axi skill. */
export function createSkillMarkdown(): string {
  return `---
name: usage-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
---

# usage-axi

${DESCRIPTION}

You do not need usage-axi installed globally - invoke it with \`npx -y usage-axi\`.

usage-axi is data only: it never routes, recommends, proxies, logs in, refreshes
credentials, or mutates provider state. It reads the OpenUsage CLI, quota-axi, the
\`opencode models\` catalog, and the local machine, then prints what it found.

## When to use

Use usage-axi whenever you need provider headroom or a machine-capacity verdict before
deciding whether it is safe to keep working, when the user asks about usage, rate limits,
remaining quota, or model pools, or when a router needs the quota-axi JSON contract.

## Workflow

1. Run \`npx -y usage-axi\` for compact TOON output.
2. Pass \`--json --full\` for the quota-axi JSON contract that \`fm-dispatch-select.mjs select
   --quota-json\` accepts unchanged. The default \`--json\` already carries the 15 fields the
   selector reads; \`--full\` adds provenance attempts and the full pool model ids.
3. Pass \`--provider claude,cursor\` to scope providers, and \`--force\` to bypass OpenUsage's
   five-minute cache and refresh now.
4. Run \`npx -y usage-axi machine\` for the capacity verdict used by agent admission:
   \`agents\` against \`agentCeiling\`, \`loadPerCore\`, \`memoryFreePct\`, and \`suiteSlotFree\`.
5. Run \`npx -y usage-axi sources\` to see which adapter served which provider and how fresh it is.
6. Run \`npx -y usage-axi doctor\` to check source availability; exit 1 means no usage source was available.

## Contract

- Output is the quota-axi \`schemaVersion\` envelope extended additively: \`windows[]\` exactly as
  quota-axi, plus \`source\`, \`pools[]\`, and a top-level \`machine{}\`.
- OpenUsage is primary. quota-axi only fills providers OpenUsage lacks and never overrides an
  OpenUsage window, so a live Cursor Auto window is never hidden by quota-axi's API 0 percent.
- usage-axi never prints or stores account identity or credentials. Only percentages, window
  bounds, reset times, and pool model ids leave the tool.

## Usage

\`\`\`
${TOP_HELP.trimEnd()}

${MACHINE_HELP.trimEnd()}

${SOURCES_HELP.trimEnd()}

${DOCTOR_HELP.trimEnd()}
\`\`\`
`;
}
