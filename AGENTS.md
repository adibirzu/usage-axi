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
  window join): `adoptSemantics` in `src/sources/index.ts`.
- Machine probes, ported from firstmate's `bin/fm-capacity-lib.sh` ideas but not importing it:
  `src/sources/machine.ts`.
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

`npm test` runs vitest: source units plus the U1–U12 acceptance fixtures in
`test/acceptance.test.ts`, which build the exact `--json --full` payload from the Mac
captures in `test/fixtures/` and feed it to the vendored selector.

- Test seams (environment): `USAGE_AXI_OPENUSAGE_JSON`, `USAGE_AXI_QUOTA_AXI_JSON`,
  `USAGE_AXI_OPENCODE_MODELS`, `USAGE_AXI_MACHINE_JSON`, and the `*_BIN` overrides. These let
  the suite run on a host where `openusage` is absent.
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
