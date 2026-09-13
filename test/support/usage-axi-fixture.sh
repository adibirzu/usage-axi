#!/usr/bin/env sh
# Print `usage-axi --json --full` from the committed Mac captures. Point
# FM_DISPATCH_QUOTA_AXI at this file to prove the selector accepts usage-axi
# output unchanged without needing openusage or quota-axi on the host.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../.." && pwd)

USAGE_AXI_OPENUSAGE_JSON="$root/test/fixtures/openusage-mac-20260913.json" \
USAGE_AXI_QUOTA_AXI_JSON="$root/test/fixtures/quota-axi-mac-20260913.json" \
USAGE_AXI_OPENCODE_MODELS="$root/test/fixtures/opencode-models-mac-20260913.txt" \
  exec node "$root/dist/bin/usage-axi.js" --json --full
