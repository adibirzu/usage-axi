import { readTextFile } from "../lib/fs.js";
import { runCapture } from "../lib/process.js";
import { nowIso } from "../lib/time.js";
import { synthesizeSemantics } from "../semantics.js";
import type { ProviderQuota, QuotaWindow, WindowKind } from "../types.js";

// The raw OpenUsage `limits.v1` schema. Only the fields usage-axi reads are
// typed; everything else is ignored.
export type OpenUsageResource = {
  kind?: string;
  unit?: string;
  limit?: number;
  used?: number;
  remaining?: number;
  available?: number;
  utilization?: number;
  resetsAt?: string;
  windowSeconds?: number;
};

export type OpenUsageProvider = {
  displayName?: string;
  plan?: string;
  fetchedAt?: string;
  expiresAt?: string;
  stale?: boolean;
  error?: string;
  resources?: Record<string, OpenUsageResource>;
};

export type OpenUsagePayload = {
  generatedAt?: string;
  errors?: unknown[];
  providers?: Record<string, OpenUsageProvider>;
  schema?: string;
};

export type OpenUsageLoad =
  | { ok: true; generatedAt: string; providers: ProviderQuota[] }
  | { ok: false; reason: string };

type ResourceMap = { id: string; kind: WindowKind; label: string };

// OpenUsage resource name -> quota-axi window id. The ids are deliberately
// quota-axi's spelling, because the selector declares pools by these names:
// claude.session is five_hour, claude.weekly is seven_day, cursor.autoUsage is
// auto_usage, and so on. OpenUsage provider `antigravity` becomes provider
// `agy`, the identity the selector routes on.
const RESOURCE_MAP: Record<string, Record<string, ResourceMap>> = {
  agy: {
    geminiSession: { id: "gemini_5h", kind: "session", label: "Gemini 5h" },
    geminiWeekly: { id: "gemini_weekly", kind: "weekly", label: "Gemini week" },
    nonGeminiSession: { id: "claude_gpt_5h", kind: "session", label: "Claude/GPT 5h" },
    nonGeminiWeekly: { id: "claude_gpt_weekly", kind: "weekly", label: "Claude/GPT week" },
  },
  claude: {
    session: { id: "five_hour", kind: "session", label: "session" },
    weekly: { id: "seven_day", kind: "weekly", label: "week" },
    fable: { id: "model:fable", kind: "model", label: "Fable week" },
  },
  codex: {
    weekly: { id: "weekly", kind: "weekly", label: "week" },
  },
  copilot: {
    premiumCredits: { id: "premium_interactions", kind: "monthly", label: "premium interactions" },
    chat: { id: "chat", kind: "monthly", label: "chat" },
    completions: { id: "completions", kind: "monthly", label: "completions" },
  },
  cursor: {
    apiUsage: { id: "api_usage", kind: "monthly", label: "API usage" },
    autoUsage: { id: "auto_usage", kind: "monthly", label: "auto usage" },
    includedUsage: { id: "included_usage", kind: "monthly", label: "included usage" },
    grokBot: { id: "grok_bot", kind: "weekly", label: "Grok Bot" },
    totalUsage: { id: "total_usage", kind: "monthly", label: "total usage" },
  },
  grok: {
    weekly: { id: "credits", kind: "credits", label: "credits" },
  },
  opencode: {
    session: { id: "session", kind: "session", label: "session" },
    weekly: { id: "weekly", kind: "weekly", label: "week" },
    monthly: { id: "monthly", kind: "monthly", label: "month" },
  },
};

const PROVIDER_ALIAS: Record<string, string> = {
  antigravity: "agy",
};

const KIND_BY_NAME: Array<[RegExp, WindowKind]> = [
  [/session|five_hour|5h/i, "session"],
  [/week|seven_day/i, "weekly"],
  [/month/i, "monthly"],
  [/credit|balance/i, "credits"],
  [/model/i, "model"],
];

function fallbackMap(resource: string): ResourceMap {
  const kind = KIND_BY_NAME.find(([pattern]) => pattern.test(resource))?.[1] ?? "unknown";
  return { id: resource, kind, label: resource };
}

function toPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resourceToWindow(resource: string, data: OpenUsageResource): QuotaWindow {
  const mapping = fallbackMap(resource);
  const window: QuotaWindow = { id: mapping.id, kind: mapping.kind, label: mapping.label };
  const percentResource = data.unit === "percent" || data.limit === 100;
  if (percentResource) {
    const remaining = toPercent(data.remaining);
    if (remaining !== undefined && remaining >= 0 && remaining <= 100) {
      window.percentRemaining = remaining;
      window.percentUsed = toPercent(data.used);
    } else if (typeof data.utilization === "number" && Number.isFinite(data.utilization)) {
      window.percentRemaining = Math.max(0, Math.min(100, (1 - data.utilization) * 100));
    }
  }
  if (typeof data.resetsAt === "string") window.resetsAt = data.resetsAt;
  if (typeof data.windowSeconds === "number") window.windowSeconds = data.windowSeconds;
  return window;
}

/** Resolve the raw OpenUsage payload, from a fixture seam or the CLI. */
async function loadPayload(force: boolean): Promise<{ ok: true; payload: OpenUsagePayload } | { ok: false; reason: string }> {
  const fixture = process.env["USAGE_AXI_OPENUSAGE_JSON"];
  let text: string;
  if (fixture) {
    const read = readTextFile(fixture);
    if (read === null) return { ok: false, reason: `openusage fixture unreadable: ${fixture}` };
    text = read;
  } else {
    const binary = process.env["USAGE_AXI_OPENUSAGE_BIN"] || "openusage";
    const result = await runCapture(binary, force ? ["--force"] : []);
    if (!result.ok) return { ok: false, reason: `openusage unavailable: ${result.reason}` };
    text = result.stdout;
  }
  try {
    const payload = JSON.parse(text) as OpenUsagePayload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, reason: "openusage payload malformed" };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "openusage payload malformed" };
  }
}

/**
 * Map OpenUsage resources onto the quota-axi provider/window contract.
 *
 * Every resource becomes one `windows[]` row. Percent-unit resources carry
 * `percentRemaining`; balance resources (credits, usd, resets) are emitted as
 * rows without a percentage so the selector never reads a zero balance as a
 * live quota figure.
 */
export async function loadOpenUsage(force: boolean): Promise<OpenUsageLoad> {
  const loaded = await loadPayload(force);
  if (!loaded.ok) return loaded;
  const { payload } = loaded;
  const rawProviders = payload.providers;
  if (!rawProviders || typeof rawProviders !== "object") {
    return { ok: false, reason: "openusage payload has no providers" };
  }

  const providers: ProviderQuota[] = [];
  for (const [rawId, rawProvider] of Object.entries(rawProviders)) {
    const provider = PROVIDER_ALIAS[rawId] ?? rawId;
    const windows: QuotaWindow[] = [];
    for (const [resource, data] of Object.entries(rawProvider.resources ?? {})) {
      const map = RESOURCE_MAP[provider]?.[resource];
      const window = resourceToWindow(resource, data);
      if (map) {
        window.id = map.id;
        window.kind = map.kind;
        window.label = map.label;
      }
      windows.push(window);
    }
    const stale = rawProvider.stale === true;
    let status: ProviderQuota["state"]["status"] = "fresh";
    if (rawProvider.error) status = "error";
    else if (stale) status = "stale";
    providers.push({
      provider,
      label: rawProvider.displayName ?? provider,
      source: "openusage",
      ...(rawProvider.plan ? { plan: rawProvider.plan } : {}),
      windows,
      quotaSemantics: synthesizeSemantics(provider, windows),
      state: {
        status,
        stale,
        ...(rawProvider.fetchedAt ? { refreshedAt: rawProvider.fetchedAt } : {}),
        ...(rawProvider.error ? { error: rawProvider.error } : {}),
        sourcesTried: ["openusage"],
      },
    });
  }

  return {
    ok: true,
    generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : nowIso(),
    providers,
  };
}
