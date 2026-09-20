import type { OpencodeCatalogLoad } from "./sources/opencode-catalog.js";
import type { FallbackPolicy, ProviderQuota, RouteFamily, RouteOutcome, RoutingReport } from "./types.js";

const LOCAL_QWEN_MODELS = new Set([
  "qwen38fn/qwen3.8-flash",
  "vllm/qwen3.8-flash",
  "vllm/auto-code",
]);

function hasZenCatalogModel(catalog: OpencodeCatalogLoad): boolean {
  return catalog.ok && catalog.models.some((model) => model.startsWith("vllm/zen-"));
}

function hasGoCatalogModel(catalog: OpencodeCatalogLoad): boolean {
  return catalog.ok && catalog.models.some((model) => model.startsWith("opencode-go/"));
}

function localQwenAvailability(catalog: OpencodeCatalogLoad): "catalog_available" | "unavailable" {
  return catalog.ok && catalog.models.some((model) => LOCAL_QWEN_MODELS.has(model))
    ? "catalog_available"
    : "unavailable";
}

function routeOutcome(provider: ProviderQuota | undefined): RouteOutcome {
  if (!provider) {
    return { status: "unknown", reason: "telemetry_unavailable", windows: [], evidence: [] };
  }

  const exhausted = provider.windows.filter((window) => window.percentRemaining === 0);
  const base = {
    provider: provider.provider,
    windows: exhausted.map((window) => window.id),
    evidence: exhausted.map((window) => ({
      source: provider.source,
      provider: provider.provider,
      stateStatus: provider.state.status,
      windowId: window.id,
      percentRemaining: window.percentRemaining,
    })),
  };
  if (provider.state.status === "rate_limited") {
    return {
      status: "blocked",
      reason: "rate_limited",
      ...base,
      windows: provider.windows.map((window) => window.id),
      evidence: [{ source: provider.source, provider: provider.provider, stateStatus: provider.state.status }],
    };
  }
  if (exhausted.length) return { status: "blocked", reason: "quota_exhausted", ...base };
  if (provider.state.status === "fresh" && provider.windows.some((window) => window.percentRemaining !== undefined)) {
    return {
      status: "available",
      reason: "quota_available",
      provider: provider.provider,
      windows: provider.windows.map((window) => window.id),
      evidence: [{ source: provider.source, provider: provider.provider, stateStatus: provider.state.status }],
    };
  }
  return {
    status: "unknown",
    reason: "telemetry_unavailable",
    provider: provider.provider,
    windows: provider.windows.map((window) => window.id),
    evidence: [{ source: provider.source, provider: provider.provider, stateStatus: provider.state.status }],
  };
}

function zenProvider(providers: ProviderQuota[]): ProviderQuota | undefined {
  return providers.find((provider) => provider.provider === "zen") ?? providers.find(
    (provider) => provider.provider === "opencode" && /\bzen\b/i.test(`${provider.label} ${provider.plan ?? ""}`),
  );
}

function goProvider(providers: ProviderQuota[]): ProviderQuota | undefined {
  return providers.find((provider) => provider.provider === "opencode-go") ?? providers.find(
    (provider) => provider.provider === "opencode" && /\bgo\b/i.test(`${provider.label} ${provider.plan ?? ""}`),
  );
}

/**
 * Publish the verified OpenCode route-family evidence and a local-only fallback
 * policy. It is an additive report for a router to consume, never an attempt
 * to launch, retry, or switch a model from usage-axi.
 */
export function buildRoutingReport(providers: ProviderQuota[], catalog: OpencodeCatalogLoad): RoutingReport {
  const go = goProvider(providers);
  const zen = zenProvider(providers);
  const routeFamilies: RouteFamily[] = [];
  if (go || hasGoCatalogModel(catalog)) routeFamilies.push({ id: "opencode-go", outcome: routeOutcome(go) });
  if (zen || hasZenCatalogModel(catalog)) routeFamilies.push({ id: "zen", outcome: routeOutcome(zen) });

  const target: FallbackPolicy["target"] = {
    provider: "litellm",
    model: "qwen3.8-flash",
    availability: localQwenAvailability(catalog),
    localOnly: true,
  };
  return {
    routeFamilies,
    fallbackPolicies: [{
      from: [
        { routeFamily: "opencode-go", outcome: "blocked" },
        { routeFamily: "zen", outcome: "blocked" },
      ],
      target,
      preserve: ["taskId", "reasoningClass"],
      onTargetUnavailable: "fail",
    }],
  };
}
