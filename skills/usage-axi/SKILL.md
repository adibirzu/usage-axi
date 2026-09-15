---
name: usage-axi
description: "One truthful picture of every subscription, free pool, and local machine capacity via the usage-axi CLI - OpenUsage first, quota-axi as a fallback, opencode model pools, and machine headroom, in the quota-axi JSON contract routing agents already consume. Use before deciding whether a provider has headroom, when the user asks about usage, rate limits, remaining quota, or whether the machine can take another agent."
user-invocable: false
author: Adrian Birzu
---

# usage-axi

One truthful picture of every subscription, free pool, and machine capacity, in the quota-axi JSON contract routing agents already consume.

You do not need usage-axi installed globally - invoke it with `npx -y usage-axi`.

usage-axi is data only: it never routes, recommends, proxies, logs in, refreshes
credentials, or mutates provider state. It reads the OpenUsage CLI, quota-axi, the
`opencode models` catalog, and the local machine, then prints what it found.

## When to use

Use usage-axi whenever you need provider headroom or a machine-capacity verdict before
deciding whether it is safe to keep working, when the user asks about usage, rate limits,
remaining quota, or model pools, or when a router needs the quota-axi JSON contract.

## Workflow

1. Run `npx -y usage-axi` for compact TOON output.
2. Pass `--json --full` for the quota-axi JSON contract that `fm-dispatch-select.mjs select
   --quota-json` accepts unchanged. The default `--json` already carries the 15 fields the
   selector reads; `--full` adds provenance attempts and the full pool model ids.
3. Pass `--provider claude,cursor` to scope providers, and `--force` to bypass OpenUsage's
   five-minute cache and refresh now.
4. Run `npx -y usage-axi machine` for the capacity verdict used by agent admission:
   `agents` against `agentCeiling`, `loadPerCore`, `memoryFreePct`, and `suiteSlotFree`.
5. Run `npx -y usage-axi sources` to see which adapter served which provider and how fresh it is.
6. Run `npx -y usage-axi doctor` to check source availability; exit 1 means no usage source was available.

## Contract

- Output is the quota-axi `schemaVersion` envelope extended additively: `windows[]` exactly as
  quota-axi, plus `source`, `pools[]`, and a top-level `machine{}`.
- OpenUsage is primary. quota-axi only fills providers OpenUsage lacks and never overrides an
  OpenUsage window, so a live Cursor Auto window is never hidden by quota-axi's API 0 percent.
- usage-axi never prints or stores account identity or credentials. Only percentages, window
  bounds, reset times, and pool model ids leave the tool.

## Usage

```
usage: usage-axi [command] [flags]
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

usage: usage-axi machine [flags]
description:
  Report local agents, agent ceiling, 1-minute load per core, memory free percent, and suite slot.
  agents counts invocation roots: a process whose command basename is a firstmate adapter
  (claude, codex, opencode, pi, pi-signed, grok, kimi, cline, cursor-agent, copilot, muse, agy),
  or begins with one followed by -/_/., or - for a bare node/python - whose argv names an
  adapter. Matching descendants of a matching ancestor collapse to one invocation (a Codex
  node wrapper, codex binary, and codex-code-mode-host count as 1). Cursor private-worker /
  worker-start daemons are not task sessions and are excluded; a standalone cursor-agent is
  counted. usage-axi's own transient probes are excluded. This diverges from
  fm_capacity_fleet_totals, which still counts each matching process. machine --json prints
  roots: every counted pid with its comm basename and matched adapter.
  Set USAGE_AXI_MACHINE_PS_COMM and USAGE_AXI_MACHINE_PS_ARGV to two ps snapshot files
  (ps -ax -o pid=,ppid=,rss=,comm= and ps -ax -o pid=,args=) to replay a captured machine.
  memoryFreePct is the OS free-memory reading: macOS memory_pressure -Q free percent (falling back
  to vm_stat free+speculative), Linux MemAvailable as a share of MemTotal.
flags[2]:
  --json, --help
examples:
  usage-axi machine
  usage-axi machine --json

usage: usage-axi sources [flags]
description:
  Report which usage adapter served which data, and how fresh each source is.
flags[2]:
  --json, --help
examples:
  usage-axi sources
  usage-axi sources --json

usage: usage-axi doctor [flags]
description:
  Check source availability and contract health; exit 1 when no usage source is available.
flags[2]:
  --json, --help
examples:
  usage-axi doctor
  usage-axi doctor --json
```
