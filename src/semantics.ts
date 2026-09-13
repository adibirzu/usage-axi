import type {
  EffectiveAvailability,
  QuotaSemantics,
  QuotaWindow,
} from "./types.js";

export function usablePercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * Compute the aggregate availability a provider's own windows imply: the
 * conservative minimum across every usable live window. This is the same
 * provider-wide reading `fm-dispatch-select.mjs` computes from windows, and it
 * is what usage-axi publishes when the upstream source supplies no
 * interpretation of its own (OpenUsage reports raw resources only).
 *
 * A declared quota window still bypasses this aggregate; the selector prices
 * the declared window alone. The aggregate is the conservative default.
 */
export function synthesizeSemantics(
  provider: string,
  windows: QuotaWindow[],
): QuotaSemantics {
  const usable = windows.filter((window) => usablePercent(window.percentRemaining));
  if (!usable.length) {
    return {
      status: "unknown",
      description: `No usable live percentage is reported for ${provider}, so no effective remaining value can be computed.`,
      effectiveAvailability: [],
    };
  }
  const minimum = Math.min(...usable.map((window) => window.percentRemaining as number));
  const limitingWindowIds = usable
    .filter((window) => window.percentRemaining === minimum)
    .map((window) => window.id);
  const availability: EffectiveAvailability = {
    scope: "all_models",
    status: "known",
    effectivePercentRemaining: minimum,
    boundedBy: usable.map((window) => window.id),
    limitingWindowIds,
  };
  return {
    status: "known",
    description: `${provider} windows jointly bound every model, so effective remaining is the minimum across the reported windows.`,
    effectiveAvailability: [availability],
  };
}

/** Tightest usable remaining percentage across the named windows. */
export function poolRemaining(
  windows: QuotaWindow[],
  windowIds: string[],
): number | undefined {
  const values = windows
    .filter((window) => windowIds.includes(window.id))
    .map((window) => window.percentRemaining)
    .filter(usablePercent);
  return values.length ? Math.min(...values) : undefined;
}
