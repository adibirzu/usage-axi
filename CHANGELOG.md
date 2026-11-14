# Changelog

## 0.1.3

Changes since 0.1.2 (`cef0753`).

- **quota-axi:** raise child-process read deadline to 30s so multi-provider runs exceeding 15s retain valid telemetry while still failing closed past budget (#10), and preserve read-only producer failure evidence (`14e3776`).
- **machine:** probe local `llama.cpp` parallel slots for capacity telemetry (`908b5c2`).
- **docs:** consolidate canonical project agent guidance in `AGENTS.md`.

## 0.1.2

Changes since the `b140738` installer pin (0.1.1).

- **machine:** `agents` now counts harness *invocations*, not matching processes (#6). A matching
  process whose ancestor also matches collapses into that ancestor (a Codex node wrapper, the
  `codex` binary, and `codex-code-mode-host` count as 1), and Cursor `private-worker` /
  `worker-start` daemons are no longer counted as task sessions. A standalone `cursor-agent`
  still counts. `machine.roots` / `--json` still lists every counted pid, `comm` basename, and
  matched adapter. This intentionally diverges from firstmate `fm_capacity_fleet_totals`, which
  still counts each matching process.
- **routing:** additive, optional `routing` object in `--json --full` (#7): OpenCode route-family
  availability evidence and a declarative local-Qwen fallback policy. usage-axi reports this data
  only; it never selects or switches a route. `schemaVersion` stays 5 and the 15 selector fields
  in the default `--json` are unchanged.
- **docs:** install-from-git-`main` instructions and machine-root documentation (#5).

No credential, account-identity, or provider-mutation behavior changed. Not published to npm.
