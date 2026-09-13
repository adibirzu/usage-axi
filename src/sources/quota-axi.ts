import { readTextFile } from "../lib/fs.js";
import { runCapture } from "../lib/process.js";
import { nowIso } from "../lib/time.js";
import { synthesizeSemantics } from "../semantics.js";
import type {
  EffectiveAvailability,
  ProviderQuota,
  ProviderStatus,
  QuotaSemantics,
  QuotaWindow,
  SourceAttempt,
  WindowKind,
} from "../types.js";

export type QuotaAxiLoad =
  | { ok: true; generatedAt: string; providers: ProviderQuota[] }
  | { ok: false; reason: string };

const KINDS = new Set<WindowKind>(["session", "weekly", "monthly", "model", "credits", "unknown"]);
const STATUSES = new Set<ProviderStatus>([
  "fresh",
  "stale",
  "unavailable",
  "auth_required",
  "rate_limited",
  "error",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function normalizeWindow(raw: unknown): QuotaWindow | null {
  if (!isObject(raw)) return null;
  const id = stringOr(raw["id"], "");
  if (!id) return null;
  const kind = stringOr(raw["kind"], "unknown") as WindowKind;
  const window: QuotaWindow = {
    id,
    label: stringOr(raw["label"], id),
    kind: KINDS.has(kind) ? kind : "unknown",
  };
  for (const key of ["percentUsed", "percentRemaining", "windowSeconds"] as const) {
    if (typeof raw[key] === "number") window[key] = raw[key] as number;
  }
  if (typeof raw["resetsAt"] === "string") window.resetsAt = raw["resetsAt"];
  if (typeof raw["startsAt"] === "string") window.startsAt = raw["startsAt"];
  if (isObject(raw["pace"])) window.pace = raw["pace"] as QuotaWindow["pace"];
  return window;
}

function normalizeSemantics(raw: unknown, provider: string, windows: QuotaWindow[]): QuotaSemantics {
  if (!isObject(raw) || !Array.isArray(raw["effectiveAvailability"])) {
    return synthesizeSemantics(provider, windows);
  }
  const availability: EffectiveAvailability[] = [];
  for (const item of raw["effectiveAvailability"]) {
    if (!isObject(item)) continue;
    const entry: EffectiveAvailability = {
      scope: stringOr(item["scope"], "all_models"),
      status: item["status"] === "known" ? "known" : "unknown",
      boundedBy: Array.isArray(item["boundedBy"])
        ? item["boundedBy"].filter((id): id is string => typeof id === "string")
        : [],
    };
    if (typeof item["effectivePercentRemaining"] === "number") {
      entry.effectivePercentRemaining = item["effectivePercentRemaining"];
    }
    if (Array.isArray(item["limitingWindowIds"])) {
      entry.limitingWindowIds = item["limitingWindowIds"].filter(
        (id): id is string => typeof id === "string",
      );
    }
    if (isObject(item["selection"])) {
      const status = item["selection"]["status"] === "known" ? "known" : "unknown";
      const spend = item["selection"]["spendPriority"];
      entry.selection = {
        status,
        ...(status === "known" && typeof spend === "number" && Number.isFinite(spend)
          ? { spendPriority: spend }
          : { status: "unknown" as const }),
      };
    }
    availability.push(entry);
  }
  const status = raw["status"] === "known" || raw["status"] === "partial" ? raw["status"] : "unknown";
  return {
    status,
    description: stringOr(raw["description"], `${provider} quota semantics supplied by quota-axi.`),
    effectiveAvailability: availability,
    ...(Array.isArray(raw["unresolvedWindowIds"])
      ? {
          unresolvedWindowIds: raw["unresolvedWindowIds"].filter(
            (id): id is string => typeof id === "string",
          ),
        }
      : {}),
  };
}

function normalizeAttempts(raw: unknown): SourceAttempt[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const attempts: SourceAttempt[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const status = item["status"];
    if (status !== "success" && status !== "failed" && status !== "skipped") continue;
    attempts.push({
      source: stringOr(item["source"], "unknown"),
      status,
      ...(typeof item["error"] === "string" ? { error: item["error"] } : {}),
    });
  }
  return attempts.length ? attempts : undefined;
}

/**
 * Pass-through adapter for the quota-axi contract. It preserves windows,
 * quotaSemantics (including spendPriority), state, and credits verbatim, and
 * deliberately drops `account` identity: usage-axi never prints account
 * identity or credentials.
 */
export async function loadQuotaAxi(): Promise<QuotaAxiLoad> {
  const fixture = process.env["USAGE_AXI_QUOTA_AXI_JSON"];
  let text: string;
  if (fixture) {
    const read = readTextFile(fixture);
    if (read === null) return { ok: false, reason: `quota-axi fixture unreadable: ${fixture}` };
    text = read;
  } else {
    const binary = process.env["USAGE_AXI_QUOTA_AXI_BIN"] || "quota-axi";
    const result = await runCapture(binary, ["--json"]);
    if (!result.ok) return { ok: false, reason: `quota-axi unavailable: ${result.reason}` };
    text = result.stdout;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: "quota-axi payload malformed" };
  }
  if (!isObject(payload) || !Array.isArray(payload["providers"])) {
    return { ok: false, reason: "quota-axi payload malformed" };
  }

  const providers: ProviderQuota[] = [];
  for (const raw of payload["providers"]) {
    if (!isObject(raw)) continue;
    const provider = stringOr(raw["provider"], "");
    if (!provider) continue;
    const windows = (Array.isArray(raw["windows"]) ? raw["windows"] : [])
      .map(normalizeWindow)
      .filter((window): window is QuotaWindow => window !== null);
    const state = isObject(raw["state"]) ? raw["state"] : {};
    const status = stringOr(state["status"], "unavailable") as ProviderStatus;
    const credits: ProviderQuota["credits"] = isObject(raw["credits"])
      ? {
          ...(typeof raw["credits"]["remaining"] === "number"
            ? { remaining: raw["credits"]["remaining"] }
            : {}),
          ...(typeof raw["credits"]["unlimited"] === "boolean"
            ? { unlimited: raw["credits"]["unlimited"] }
            : {}),
          ...(typeof raw["credits"]["unit"] === "string" ? { unit: raw["credits"]["unit"] } : {}),
        }
      : undefined;
    const attempts = normalizeAttempts(raw["attempts"]);
    providers.push({
      provider,
      label: stringOr(raw["label"], provider),
      source: "quota-axi",
      ...(typeof raw["plan"] === "string" && raw["plan"] ? { plan: raw["plan"] } : {}),
      windows,
      quotaSemantics: normalizeSemantics(raw["quotaSemantics"], provider, windows),
      ...(credits ? { credits } : {}),
      state: {
        status: STATUSES.has(status) ? status : "error",
        stale: state["stale"] === true,
        ...(typeof state["refreshedAt"] === "string" ? { refreshedAt: state["refreshedAt"] } : {}),
        ...(typeof state["error"] === "string" ? { error: state["error"] } : {}),
        ...(Array.isArray(state["sourcesTried"])
          ? { sourcesTried: state["sourcesTried"].filter((s): s is string => typeof s === "string") }
          : {}),
      },
      ...(attempts ? { attempts } : {}),
    });
  }

  return {
    ok: true,
    generatedAt: typeof payload["generatedAt"] === "string" ? payload["generatedAt"] : nowIso(),
    providers,
  };
}
