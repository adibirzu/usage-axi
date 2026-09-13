import { readTextFile } from "../lib/fs.js";
import { runCapture } from "../lib/process.js";

export type OpencodeCatalogLoad =
  | {
      ok: true;
      total: number;
      pools: { id: string; label: string; models: string[] }[];
      otherCount: number;
    }
  | { ok: false; reason: string };

const POOL_PREFIXES: Array<{ id: string; label: string; prefix: string }> = [
  { id: "opencode-go", label: "OpenCode Go", prefix: "opencode-go/" },
  { id: "opencode", label: "OpenCode free", prefix: "opencode/" },
];

/**
 * Read `opencode models` and split the ids into the separately billed pools.
 * The catalog supplies no quota windows of its own; the merge step attaches
 * these pools to the live `opencode` provider that OpenUsage reports so the Go
 * pool can be priced by id in P2.
 */
export async function loadOpencodeCatalog(): Promise<OpencodeCatalogLoad> {
  const fixture = process.env["USAGE_AXI_OPENCODE_MODELS"];
  let text: string;
  if (fixture) {
    const read = readTextFile(fixture);
    if (read === null) return { ok: false, reason: `opencode models fixture unreadable: ${fixture}` };
    text = read;
  } else {
    const binary = process.env["USAGE_AXI_OPENCODE_BIN"] || "opencode";
    const result = await runCapture(binary, ["models"]);
    if (!result.ok) return { ok: false, reason: `opencode unavailable: ${result.reason}` };
    text = result.stdout;
  }

  const models = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (!models.length) return { ok: false, reason: "opencode models returned no model ids" };

  const pools = POOL_PREFIXES.map((pool) => ({
    id: pool.id,
    label: pool.label,
    models: models.filter((model) => model.startsWith(pool.prefix)),
  }));
  const otherCount = models.length - pools.reduce((sum, pool) => sum + pool.models.length, 0);

  return { ok: true, total: models.length, pools, otherCount };
}
