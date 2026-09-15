# Machine ps snapshots

Each snapshot is a pair of `ps` captures plus the invocation-root golden
`readFleet` must reproduce, so tests prove `machine.agents` is the number of
harness invocations on that process table.

Files per snapshot `<name>`:

- `<name>.comm.ps` — `ps -ax -o pid=,ppid=,rss=,comm=`
- `<name>.argv.ps` — `ps -ax -o pid=,args=`
- `<name>.json` — capture metadata and `golden: {residentMb, agents, procs}`

`test/sources/machine.test.ts` discovers every `.json` here and asserts
`readFleet` reproduces `golden`.

`golden` is usage-axi's invocation-root contract: matching descendants of a
matching ancestor collapse to one, and Cursor private-worker / worker-start
daemons are excluded. firstmate's `fm_capacity_fleet_totals` still counts each
matching process. When a snapshot was also measured by the fork, record that
count as `forkGolden` so the drift stays visible; do not treat the two as equal
and do not edit firstmate here.

Argv in committed snapshots is redacted (truncated or rewritten) so worker
prompts and credentials never land in the repo. Matching tokens (`codex`,
`cursor-agent`, `private-worker`, `worker start`) are kept because the
classifier reads them.

## Contract fixtures

- `adi1-20260913` — real adi1 host snapshot. `golden.agents` is the
  invocation-root count; `forkGolden.agents` is `fm_capacity_fleet_totals` on
  the same table (node argv-codex plus child `codex` comm counted twice there).
- `codex-triple` — node wrapper (argv names `codex`) → `codex` binary →
  `codex-code-mode-host`. Counts as 1.
- `cursor-daemon` — Cursor Helper (already unmatched), a `worker start` daemon
  and its matching child, a `private-worker` daemon, and a standalone
  `cursor-agent` task. Counts as 1.

## Dropping in a macOS snapshot (the 13-vs-10 case)

The architect's Mac capture belongs here as `mac-mini-<YYYYMMDD>.{comm,argv}.ps`
plus `mac-mini-<YYYYMMDD>.json`, copied from
`~/.firstmate-axi/data/axi-router-program/fixtures/` (the architect's drop
point). Capture it with:

```sh
ps -ax -o pid=,ppid=,rss=,comm= > mac-mini-<YYYYMMDD>.comm.ps
ps -ax -o pid=,args= > mac-mini-<YYYYMMDD>.argv.ps
```

Redact argv (truncate to ~120 characters, strip prompts and credentials) before
committing. Record `golden` from `readFleet` on the redacted pair, and
`forkGolden` from the fork's probe at the same instant if available:

```sh
. bin/fm-capacity-lib.sh   # adibirzu/firstmate origin/main
fm_capacity_fleet_totals \
  "$(cat mac-mini-<YYYYMMDD>.comm.ps)" \
  "$(cat mac-mini-<YYYYMMDD>.argv.ps)"
```

Any pair can also be replayed ad hoc without touching the repo:

```sh
USAGE_AXI_MACHINE_PS_COMM=... USAGE_AXI_MACHINE_PS_ARGV=... usage-axi machine --json
```
