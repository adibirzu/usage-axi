# AGENTS.md

Project-intrinsic knowledge for `usage-axi`. Keep edits here short and point at the
authoritative file or command instead of copying detail.

## What this is

AXI CLI (Node 22, TypeScript, no native deps, ARM64-clean) that merges OpenUsage,
quota-axi, the `opencode models` catalog, and local machine capacity into one report. The
output is the quota-axi `schemaVersion` envelope extended additively so
`fm-dispatch-select.mjs select --quota-json` accepts it unchanged.

## Authoritative files

- Output contract and the additive fields: `src/types.ts`; JSON shaping in `src/render.ts`.
- The 15 selector fields the default `--json` must always carry are listed in the P0
  contracts (`data/axi-p0-contracts/contracts.md` section 4.1 in the firstmate home) and
  asserted in `test/cli.test.ts`.
- OpenUsage resource → quota-axi window id map: `src/sources/openusage.ts` (`RESOURCE_MAP`,
  `PROVIDER_ALIAS`). `antigravity` is presented as provider `agy`.
- Merge rule (OpenUsage windows win; quota-axi may only supply semantics with no dangling
  window join; a provider OpenUsage reports with zero windows is filled from quota-axi):
  `mergeProviders`/`adoptSemantics` in `src/sources/index.ts`.
- A cold `openusage` read is cache-first (no `--force`) and gets a 180s ceiling
  (`DEFAULT_OPENUSAGE_TIMEOUT_MS`, override `USAGE_AXI_OPENUSAGE_TIMEOUT_MS` in
  `src/sources/openusage.ts`). OpenUsage's own `provider.stale` is a cache-TTL flag and must
  never reach the selector contract: it is presented fresh with the flag preserved additively
  as `state.cacheStale`. A failed adapter must show up in the additive `sources[]` in
  `--json [--full]`, never silently downgrade the document.
- Machine probes, ported from firstmate's `bin/fm-capacity-lib.sh` but not importing it:
  `src/sources/machine.ts`. `readFleet` uses the same adapter-name matcher, then counts
  process-tree-aware *invocation* roots (matching descendants collapse; Cursor
  private-worker / worker-start daemons are not task sessions). This diverges from
  firstmate `fm_capacity_fleet_totals`, which still counts each matching process.
  `machine.roots`/`--json` lists every counted pid, comm basename, and matched adapter so the
  number is auditable. `measureMachine` excludes usage-axi's own probe tree
  (`processTreePids`) and `collectUsage` takes the ps snapshot before spawning any probe, so a
  concurrent `opencode models` read never inflates the count.
- CLI routing/default command: `normalizeArgv` in `src/cli.ts` (flag-first invocations route
  to the implicit `quota` command).

## Invariants

- Never print or store credentials or account identity. Only percentages, window bounds,
  reset times, and pool model ids leave the tool. `test/sources/quota-axi.test.ts` guards it.
- usage-axi is data only: no routing, recommendations, credential refresh, or provider
  mutation.
- Default output is TOON; `--json` is the contract; `--full` adds provenance and pool model ids.
- Exit codes: 0 success, 1 no provider returned data (or doctor found no source), 2 usage error.
- No interactive prompts, ever.

## Tests

`npm test` runs vitest: source units plus the U1–U17 acceptance fixtures in
`test/acceptance.test.ts`, which build the exact `--json --full` payload from the Mac
captures in `test/fixtures/` and feed it to the vendored selector.

- Test seams (environment): `USAGE_AXI_OPENUSAGE_JSON`, `USAGE_AXI_QUOTA_AXI_JSON`,
  `USAGE_AXI_OPENCODE_MODELS`, `USAGE_AXI_MACHINE_JSON`, `USAGE_AXI_MACHINE_PS_COMM` /
  `USAGE_AXI_MACHINE_PS_ARGV` (replay a two-file `ps` snapshot), and the `*_BIN` overrides.
  These let the suite run on a host where `openusage` is absent.
- `test/fixtures/machine/` holds `ps` snapshots plus the invocation-root golden
  `test/sources/machine.test.ts` asserts `readFleet` reproduces. Its README documents
  firstmate `fm_capacity_fleet_totals` drift and where a macOS capture goes:
  `mac-mini-<date>.{comm,argv}.ps`.
- `test/support/fm-dispatch-select.mjs` is a pinned read-only copy of firstmate
  `origin/main`'s selector (MIT, Copyright (c) 2026 Kun Chen). The real selector on the Mac is
  the source of truth for parity; re-vendor only when the selector contract changes.
- `test/support/usage-axi-fixture.sh` prints `usage-axi --json --full` from the fixtures for
  use as `FM_DISPATCH_QUOTA_AXI`.

## Commands

```sh
npm run build      # tsc -> dist/bin/usage-axi.js
npm test           # vitest
npm run lint
npm run typecheck
npm run build:skill # regenerate skills/usage-axi/SKILL.md
```

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
