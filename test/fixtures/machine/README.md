# Machine ps snapshots

Each snapshot is a real pair of `ps` captures plus the `fm_capacity_fleet_totals`
golden it produces, so tests prove `readFleet` (and therefore `machine.agents`)
equals the fork's count on the same process table.

Files per snapshot `<host>-<YYYYMMDD>`:

- `<host>-<YYYYMMDD>.comm.ps` — `ps -ax -o pid=,ppid=,rss=,comm=`
- `<host>-<YYYYMMDD>.argv.ps` — `ps -ax -o pid=,args=`
- `<host>-<YYYYMMDD>.json` — capture metadata and `golden: {residentMb, agents, procs}`

`test/sources/machine.test.ts` discovers every `.json` here and asserts the
ported matcher reproduces its `golden`.

## Dropping in a macOS snapshot (the 13-vs-10 case)

The architect's Mac capture belongs here as `mac-mini-<YYYYMMDD>.{comm,argv}.ps`
plus `mac-mini-<YYYYMMDD>.json`, copied from
`~/.firstmate-axi/data/axi-router-program/fixtures/` (the architect's drop
point). Capture it with:

```sh
ps -ax -o pid=,ppid=,rss=,comm= > mac-mini-<YYYYMMDD>.comm.ps
ps -ax -o pid=,args= > mac-mini-<YYYYMMDD>.argv.ps
```

and record the golden from the fork's probe at the same instant:

```sh
. bin/fm-capacity-lib.sh   # adibirzu/firstmate origin/main
fm_capacity_fleet_totals \
  "$(cat mac-mini-<YYYYMMDD>.comm.ps)" \
  "$(cat mac-mini-<YYYYMMDD>.argv.ps)"
```

If the golden disagrees with the ported matcher, the test fails with the exact
counts, which pins the divergence instead of hiding it.

Any pair can also be replayed ad hoc without touching the repo:

```sh
USAGE_AXI_MACHINE_PS_COMM=... USAGE_AXI_MACHINE_PS_ARGV=... usage-axi machine --json
```
