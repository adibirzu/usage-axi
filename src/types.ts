// The usage-axi output contract.
//
// It is the quota-axi `--json --full` schemaVersion envelope, extended
// additively so `fm-dispatch-select.mjs select --quota-json` accepts it
// unchanged. Additions are additive only: every field the selector reads
// (providers[].windows[].id/percentRemaining and
// providers[].quotaSemantics.effectiveAvailability[]) keeps its quota-axi
// meaning, and unknown keys are ignored by the selector.
//
// usage-axi never carries account identity or credentials. Only percentages,
// window bounds, reset times, and pool model ids are emitted.

/** A provider id as the routing contract knows it (`agy`, not `antigravity`). */
export type ProviderId = string;

export type SourceId =
  | "openusage"
  | "quota-axi"
  | "opencode-catalog"
  | "machine";

export type WindowKind =
  | "session"
  | "weekly"
  | "monthly"
  | "model"
  | "credits"
  | "unknown";

export type ProviderStatus =
  | "fresh"
  | "stale"
  | "unavailable"
  | "auth_required"
  | "rate_limited"
  | "error";

export type QuotaPace = {
  status: "ahead" | "on_pace" | "behind" | "unknown";
  reason?: string;
  timeRemainingPercent?: number;
  elapsedPercent?: number;
  reservePercentPoints?: number;
  burnMultiple?: number;
  projectedExhaustedAt?: string;
  projectionConfidence?: "early" | "established";
  cycleBasis?: string;
  cycleSeconds?: number;
};

/** One reported quota window, exactly as quota-axi spells it. */
export type QuotaWindow = {
  id: string;
  label: string;
  kind: WindowKind;
  percentUsed?: number;
  percentRemaining?: number;
  startsAt?: string;
  resetsAt?: string;
  windowSeconds?: number;
  pace?: QuotaPace;
};

export type Selection = {
  status: "known" | "unknown";
  /** Present only when status is "known"; the selector ranks by the max. */
  spendPriority?: number;
};

export type EffectiveAvailability = {
  scope: string;
  status: "known" | "unknown";
  effectivePercentRemaining?: number;
  boundedBy: string[];
  limitingWindowIds?: string[];
  selection?: Selection;
};

export type QuotaSemantics = {
  status: "known" | "partial" | "unknown";
  description: string;
  effectiveAvailability: EffectiveAvailability[];
  unresolvedWindowIds?: string[];
};

export type SourceAttempt = {
  source: string;
  status: "success" | "failed" | "skipped";
  error?: string;
};

export type QuotaCredits = {
  remaining?: number;
  unlimited?: boolean;
  unit?: string;
};

/** A separately billed pool inside one provider (auto vs api, go vs free). */
export type UsagePool = {
  id: string;
  label: string;
  provider: ProviderId;
  windowIds: string[];
  /** Tightest remaining percentage across the pool's windows, when known. */
  percentRemaining?: number;
  /** Model ids in the pool, emitted only with `--full`. */
  models?: string[];
  modelCount?: number;
};

export type ProviderQuota = {
  provider: ProviderId;
  label: string;
  /** Which usage adapter supplied the identity and windows. */
  source: "openusage" | "quota-axi";
  plan?: string;
  windows: QuotaWindow[];
  quotaSemantics: QuotaSemantics;
  pools?: UsagePool[];
  credits?: QuotaCredits;
  state: {
    status: ProviderStatus;
    stale: boolean;
    /**
     * Additive provenance for an OpenUsage provider whose upstream cache
     * entry was past its TTL when read. The selector never reads this; it is
     * kept so `sources[]` can still report that the adapter served a
     * cache-expired reading.
     */
    cacheStale?: boolean;
    refreshedAt?: string;
    error?: string;
    sourcesTried?: string[];
  };
  attempts?: SourceAttempt[];
};

/** Machine capacity, measured locally and never cached. */
export type MachineCapacity = {
  agents: number | null;
  agentCeiling: number;
  loadPerCore: number | null;
  memoryFreePct: number | null;
  suiteSlotFree: boolean | null;
};

export type UsageResponse = {
  generatedAt: string;
  /** Matches the quota-axi schema the selector already parses. */
  schemaVersion: 5;
  providers: ProviderQuota[];
  machine: MachineCapacity;
  help?: string[];
};

/** A row in `usage-axi sources`: which adapter served what, and how fresh. */
export type SourceReport = {
  source: SourceId;
  status: "available" | "unavailable" | "error";
  detail: string;
  stale?: boolean;
};
