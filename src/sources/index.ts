import { parseEpochMs, nowIso } from "../lib/time.js";
import { poolRemaining, usablePercent } from "../semantics.js";
import type {
  ProviderQuota,
  QuotaSemantics,
  SourceReport,
  UsagePool,
  UsageResponse,
} from "../types.js";
import { loadOpenUsage } from "./openusage.js";
import { loadOpencodeCatalog } from "./opencode-catalog.js";
import { loadQuotaAxi } from "./quota-axi.js";
import { measureMachine } from "./machine.js";

export type CollectOptions = {
  force: boolean;
  providers?: string[];
};

export type CollectResult = {
  response: UsageResponse;
  reports: SourceReport[];
};

function referencedWindowIds(semantics: QuotaSemantics): string[] {
  const ids: string[] = [];
  for (const availability of semantics.effectiveAvailability) {
    ids.push(...availability.boundedBy);
    ids.push(...(availability.limitingWindowIds ?? []));
  }
  return ids;
}

/**
 * Adopt quota-axi's interpretation of a provider OpenUsage also reports, but
 * only when every window it references exists in the OpenUsage windows. The
 * OpenUsage windows always win; what is borrowed is the richer interpretation,
 * including the spendPriority scalar the selector ranks on. A dangling join
 * falls back to the provider-wide minimum synthesized from the live windows.
 */
function adoptSemantics(
  existing: ProviderQuota,
  incoming: ProviderQuota,
): void {
  const referenced = referencedWindowIds(incoming.quotaSemantics);
  const liveIds = new Set(existing.windows.map((window) => window.id));
  const dangling = referenced.some((id) => !liveIds.has(id));
  const usable = incoming.quotaSemantics.effectiveAvailability.some(
    (availability) => availability.status === "known" && usablePercent(availability.effectivePercentRemaining),
  );
  if (incoming.quotaSemantics.status !== "unknown" && usable && !dangling) {
    existing.quotaSemantics = incoming.quotaSemantics;
  }
}

const STATIC_POOLS: Record<string, Array<{ id: string; label: string; windowIds: string[] }>> = {
  cursor: [
    { id: "auto", label: "Cursor Auto", windowIds: ["auto_usage", "included_usage"] },
    { id: "api", label: "Cursor API", windowIds: ["api_usage"] },
  ],
  agy: [
    { id: "gemini", label: "Antigravity Gemini", windowIds: ["gemini_5h", "gemini_weekly"] },
    { id: "claude_gpt", label: "Antigravity Claude/GPT", windowIds: ["claude_gpt_5h", "claude_gpt_weekly"] },
  ],
};

function derivePools(provider: ProviderQuota): UsagePool[] | undefined {
  const pools: UsagePool[] = [];
  for (const spec of STATIC_POOLS[provider.provider] ?? []) {
    const windowIds = spec.windowIds.filter((id) => provider.windows.some((window) => window.id === id));
    if (!windowIds.length) continue;
    const remaining = poolRemaining(provider.windows, windowIds);
    pools.push({
      id: spec.id,
      label: spec.label,
      provider: provider.provider,
      windowIds,
      ...(remaining !== undefined ? { percentRemaining: remaining } : {}),
    });
  }
  return pools.length ? pools : undefined;
}

function mergeProviders(
  openusage: ProviderQuota[],
  quotaAxi: ProviderQuota[],
  opencodePools: Array<{ id: string; label: string; models: string[] }> | null,
): ProviderQuota[] {
  const merged = new Map<string, ProviderQuota>();
  for (const provider of openusage) {
    merged.set(provider.provider, { ...provider, windows: [...provider.windows] });
  }
  for (const provider of quotaAxi) {
    const existing = merged.get(provider.provider);
    if (!existing) {
      merged.set(provider.provider, { ...provider, windows: [...provider.windows] });
      continue;
    }
    // OpenUsage is primary wherever it has data, but a provider it reports with
    // zero windows carries no quota at all (an empty or failed OpenUsage
    // refresh). Letting that empty row shadow a live quota-axi provider is what
    // left claude at windows=[] while quota-axi held five_hour/seven_day/
    // model:fable. Fill the vacant provider from quota-axi instead of dropping
    // the only usable windows.
    if (existing.windows.length === 0 && provider.windows.length > 0) {
      existing.windows = [...provider.windows];
      existing.quotaSemantics = provider.quotaSemantics;
      existing.source = provider.source;
      if (!existing.plan && provider.plan) existing.plan = provider.plan;
      continue;
    }
    adoptSemantics(existing, provider);
  }

  const opencode = merged.get("opencode");
  if (opencode && opencodePools) {
    const windowIds = opencode.windows.map((window) => window.id);
    const remaining = poolRemaining(opencode.windows, windowIds);
    const pools = opencodePools
      .filter((pool) => pool.models.length > 0)
      .map((pool) => ({
        id: pool.id,
        label: pool.label,
        provider: "opencode",
        windowIds,
        ...(remaining !== undefined ? { percentRemaining: remaining } : {}),
        models: pool.models,
        modelCount: pool.models.length,
      }));
    if (pools.length) opencode.pools = pools;
  }

  for (const provider of merged.values()) {
    if (!provider.pools) {
      const derived = derivePools(provider);
      if (derived) provider.pools = derived;
    }
  }

  return [...merged.values()];
}

export async function collectUsage(options: CollectOptions): Promise<CollectResult> {
  // Measure the machine before spawning any of our own probes. The agent count
  // must not include usage-axi's transient `opencode models`/`openusage`
  // children; taking the ps snapshots first removes the race entirely, and the
  // probe-tree exclusion in `measureMachine` remains as a second guard.
  const machine = await measureMachine();
  const [openusage, quotaAxi, catalog] = await Promise.all([
    loadOpenUsage(options.force),
    loadQuotaAxi(),
    loadOpencodeCatalog(),
  ]);

  const reports: SourceReport[] = [];
  reports.push(
    openusage.ok
      ? {
          source: "openusage",
          status: "available",
          detail: `providers=${openusage.providers.length}`,
          stale: openusage.providers.some((provider) => provider.state.cacheStale === true),
        }
      : { source: "openusage", status: "unavailable", detail: openusage.reason },
  );
  reports.push(
    quotaAxi.ok
      ? { source: "quota-axi", status: "available", detail: `providers=${quotaAxi.providers.length}` }
      : { source: "quota-axi", status: "unavailable", detail: quotaAxi.reason },
  );
  reports.push(
    catalog.ok
      ? {
          source: "opencode-catalog",
          status: "available",
          detail: `models=${catalog.total} pools=${catalog.pools.filter((pool) => pool.models.length).length}`,
        }
      : { source: "opencode-catalog", status: "unavailable", detail: catalog.reason },
  );
  reports.push({
    source: "machine",
    status: "available",
    detail: `agents=${machine.agents ?? "unknown"} ceiling=${machine.agentCeiling} loadPerCore=${machine.loadPerCore ?? "unknown"} memoryFreePct=${machine.memoryFreePct ?? "unknown"} suiteSlotFree=${machine.suiteSlotFree ?? "unknown"}`,
  });

  const openusageProviders = openusage.ok ? openusage.providers : [];
  const quotaAxiProviders = quotaAxi.ok ? quotaAxi.providers : [];
  const opencodePools = catalog.ok ? catalog.pools : null;
  let providers = mergeProviders(openusageProviders, quotaAxiProviders, opencodePools);

  if (options.providers?.length) {
    const wanted = new Set(options.providers);
    providers = providers.filter((provider) => wanted.has(provider.provider));
  }

  const stamps = [openusage.ok ? openusage.generatedAt : null, quotaAxi.ok ? quotaAxi.generatedAt : null]
    .map((value) => parseEpochMs(value))
    .filter((value): value is number => value !== null);
  const generatedAt =
    stamps.length > 0 ? new Date(Math.max(...stamps)).toISOString() : nowIso();

  const response: UsageResponse = {
    generatedAt,
    schemaVersion: 5,
    providers,
    machine,
  };
  return { response, reports };
}
