# usage-axi

AXI CLI that reports **one truthful picture of every subscription, free pool, and local
machine capacity** as [quota-axi](https://github.com/kunchenguid/quota-axi)-compatible JSON or
TOON. Built for routing agents: `usage-axi --json --full` is accepted unchanged by
`fm-dispatch-select.mjs select --quota-json`.

- **OpenUsage is primary.** It reads the [`openusage`](https://github.com/robinebers/openusage)
  CLI (honouring its five-minute cache; `--force` bypasses it) and maps every resource to a
  quota-axi window id. A cold refresh gets a 90s ceiling; a failed source is surfaced in the
  additive `sources[]` instead of being swallowed into a thinner document.
- **quota-axi is secondary.** It fills providers OpenUsage lacks and never overrides an
  OpenUsage window, so a live Cursor Auto reading is never hidden by quota-axi's API `0%`. A
  provider OpenUsage reports with zero windows (an empty or failed refresh) is treated as
  lacking and filled from quota-axi.
- **opencode-catalog** splits `opencode models` into the `opencode-go` and `opencode` pools.
- **machine** measures the worker-root agent count (`fm-capacity-lib.sh`'s adapter-basename /
  argv rule), the agent ceiling, 1-minute load per core, free-memory percent (macOS
  `memory_pressure -Q` free percent, else `vm_stat` free+speculative; Linux `MemAvailable`),
  and whether a test suite is running.

usage-axi is data only. It never routes, recommends, proxies, logs in, refreshes credentials,
or writes anything but its own cache. It never prints or stores credentials or account
identity: only percentages, window bounds, reset times, and pool model ids.

## Install

```sh
npx -y usage-axi
npm install -g usage-axi
```

Requires Node 22+. No native dependencies; ARM64-clean.

## Commands

```sh
usage-axi                                   # TOON summary (default)
usage-axi --json                            # quota-axi JSON contract (15 selector fields)
usage-axi --json --full                     # + provenance attempts and pool model ids
usage-axi --provider claude,cursor --force  # scope providers, refresh OpenUsage now
usage-axi machine                           # agents, ceiling, load/core, memory, suite slot
usage-axi sources                           # which adapter served which provider
usage-axi doctor                            # source availability and contract health
usage-axi update [--check]                  # self-update
```

Flags: `--provider <list>`, `--json`, `--full`, `--force`, `--help`, `-v/--version`.
Exit codes: `0` success, `1` no provider returned data, `2` usage error.

## Output contract

`--json` emits the quota-axi `schemaVersion` envelope, extended additively:

```jsonc
{
  "generatedAt": "…",
  "schemaVersion": 5,
  "providers": [{
    "provider": "claude",
    "label": "Claude",
    "source": "openusage",          // or "quota-axi"
    "plan": "Max 20x",
    "windows": [{ "id": "five_hour", "kind": "session", "percentRemaining": 92, "resetsAt": "…", "windowSeconds": 18000 }],
    "quotaSemantics": { "status": "known", "effectiveAvailability": [{ "scope": "all_models", "status": "known", "effectivePercentRemaining": 23, "boundedBy": ["five_hour", "seven_day"], "limitingWindowIds": ["seven_day"], "selection": { "status": "known", "spendPriority": -2.8739 } }] },
    "pools": [{ "id": "opencode-go", "label": "OpenCode Go", "provider": "opencode", "windowIds": ["session", "weekly", "monthly"], "modelCount": 27 }],
    "state": { "status": "fresh", "stale": false }
  }],
  "machine": { "agents": 18, "agentCeiling": 10, "loadPerCore": 0.14, "memoryFreePct": 46.9, "suiteSlotFree": true }
}
```

The default `--json` already carries the 15 fields `fm-dispatch-select.mjs` reads
(`generatedAt`, `providers[]`, `state.status`, `state.stale`, `state.error`,
`windows[].id`, `windows[].percentRemaining`, and
`quotaSemantics.effectiveAvailability[].{status,effectivePercentRemaining,selection.status,selection.spendPriority,scope,boundedBy,limitingWindowIds}`).
`--full` adds `attempts` and full pool `models`. `machine{}`, `pools[]`, `source`, and the
`sources[]` provenance list are additive and ignored by the selector. `sources[]` carries the
per-adapter status/detail so a degraded adapter is visible in the `--json --full` document
itself.

### Window-id mapping (OpenUsage resource → quota-axi window id)

| OpenUsage | usage-axi window |
|---|---|
| `claude.session` / `weekly` / `fable` | `five_hour` / `seven_day` / `model:fable` |
| `cursor.autoUsage` / `apiUsage` / `grokBot` / `totalUsage` | `auto_usage` / `api_usage` / `grok_bot` / `total_usage` |
| `antigravity.geminiSession` / `geminiWeekly` | `gemini_5h` / `gemini_weekly` (provider `agy`) |
| `antigravity.nonGeminiSession` / `nonGeminiWeekly` | `claude_gpt_5h` / `claude_gpt_weekly` |
| `grok.weekly` | `credits` |
| `opencode.session` / `weekly` / `monthly` | same ids |
| `codex.weekly` | `weekly` |

## Development

```sh
npm install
npm test          # vitest: source units + the U1-U12 selector acceptance fixtures
npm run lint
npm run typecheck
npm run build     # dist/bin/usage-axi.js
```

`test/support/fm-dispatch-select.mjs` is a pinned, read-only copy of firstmate
`origin/main`'s selector (MIT), vendored so the acceptance tests run in CI. The tests build
the exact `usage-axi --json --full` payload from the committed Mac captures
(`test/fixtures/`) and feed it to that selector.

`test/support/usage-axi-fixture.sh` prints `usage-axi --json --full` from those fixtures and
can be used as `FM_DISPATCH_QUOTA_AXI` for a live selector proof.

## License

MIT.
