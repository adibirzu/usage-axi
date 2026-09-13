import { encode } from "@toon-format/toon";
import { collapseHome } from "./lib/fs.js";
import type {
  MachineCapacity,
  ProviderQuota,
  SourceReport,
  UsageResponse,
} from "./types.js";

export const DESCRIPTION =
  "One truthful picture of every subscription, free pool, and machine capacity, in the quota-axi JSON contract routing agents already consume.";

function usageHelp(full: boolean): string[] {
  const lines = [
    "Run `usage-axi machine` for machine capacity alone",
    "Run `usage-axi sources` for which adapter served which provider",
    "Run `usage-axi doctor` to check source availability",
    "Pass `--provider claude,cursor` to scope providers",
  ];
  if (!full) {
    lines.push("Pass `--json --full` for the full quota-axi contract, including provenance");
  } else {
    lines.push("Pass `--force` to bypass the OpenUsage cache and refresh now");
  }
  return lines;
}

export function renderHelp(lines: string[]): string {
  return `help[${lines.length}]:\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

function providerRows(response: UsageResponse, full: boolean) {
  return response.providers.map((provider) => {
    const row: Record<string, unknown> = {
      provider: provider.provider,
      plan: provider.plan ?? "unknown",
      source: provider.source,
      status: provider.state.status,
    };
    if (full) {
      row["label"] = provider.label;
      row["windows"] = provider.windows.length;
      row["pools"] = provider.pools?.length ?? 0;
      row["refreshedAt"] = provider.state.refreshedAt ?? "none";
      row["error"] = provider.state.error ?? "none";
    }
    return row;
  });
}

function windowRows(response: UsageResponse, full: boolean) {
  return response.providers.flatMap((provider) =>
    provider.windows.map((window) => {
      const row: Record<string, unknown> = {
        provider: provider.provider,
        id: window.id,
        percentRemaining: window.percentRemaining ?? "unknown",
        resetsAt: window.resetsAt ?? "unknown",
      };
      if (full) {
        row["kind"] = window.kind;
        row["label"] = window.label;
        row["percentUsed"] = window.percentUsed ?? "unknown";
        row["windowSeconds"] = window.windowSeconds ?? "unknown";
        row["pace"] = window.pace?.status ?? "unknown";
      }
      return row;
    }),
  );
}

function poolRows(response: UsageResponse, full: boolean) {
  return response.providers.flatMap((provider) =>
    (provider.pools ?? []).map((pool) => {
      const row: Record<string, unknown> = {
        provider: provider.provider,
        pool: pool.id,
        percentRemaining: pool.percentRemaining ?? "unknown",
        windows: pool.windowIds.join(" + "),
      };
      if (full) {
        row["label"] = pool.label;
        row["models"] = pool.modelCount ?? 0;
      }
      return row;
    }),
  );
}

export function renderUsageToon(
  response: UsageResponse,
  binPath: string,
  full: boolean,
): string {
  const blocks: string[] = [
    encode({
      bin: collapseHome(binPath),
      description: DESCRIPTION,
      generatedAt: response.generatedAt,
      schemaVersion: response.schemaVersion,
    }),
  ];
  if (response.providers.length === 0) {
    blocks.push(encode({ providers: [], note: "No providers were reported by any source" }));
  } else {
    blocks.push(encode({ providers: providerRows(response, full) }));
    blocks.push(encode({ windows: windowRows(response, full) }));
    const pools = poolRows(response, full);
    if (pools.length) blocks.push(encode({ pools }));
  }
  blocks.push(encode({ machine: response.machine }));
  blocks.push(renderHelp(usageHelp(full)));
  return blocks.join("\n");
}

export function renderMachineToon(machine: MachineCapacity, binPath: string): string {
  return [
    encode({
      bin: collapseHome(binPath),
      description: "Local machine capacity for agent admission",
    }),
    encode({ machine }),
    renderHelp([
      "machine is measured live and never cached",
      "agents counts verified worker roots; suiteSlotFree is true when no test suite is running",
      "Pass `--json` for the machine object without TOON framing",
    ]),
  ].join("\n");
}

export function renderSourcesToon(reports: SourceReport[], binPath: string): string {
  return [
    encode({
      bin: collapseHome(binPath),
      description: "Which usage adapter served which data, and how fresh",
    }),
    encode({
      sources: reports.map((report) => ({
        source: report.source,
        status: report.status,
        detail: report.detail,
      })),
    }),
    renderHelp([
      "Run `usage-axi` for the merged report",
      "OpenUsage is primary; quota-axi only fills providers OpenUsage lacks",
    ]),
  ].join("\n");
}

export type DoctorCheck = {
  check: string;
  status: "ok" | "warn" | "fail";
  detail: string;
};

export function renderDoctorToon(checks: DoctorCheck[], binPath: string): string {
  return [
    encode({
      bin: collapseHome(binPath),
      description: "Check usage-axi source availability and contract health",
    }),
    encode({ checks }),
    renderHelp([
      "openusage is primary; quota-axi only fills providers OpenUsage lacks",
      "Run `usage-axi sources` to see the exact adapters in this environment",
      "Exit 1 means no usage source was available",
    ]),
  ].join("\n");
}

export function doctorJson(checks: DoctorCheck[]): Record<string, unknown> {
  return { checks };
}

export type Renderable = string | Record<string, unknown>;

/** JSON shape: the quota-axi contract, minus identity, optionally full. */
export function toJsonObject(response: UsageResponse, full: boolean): Record<string, unknown> {
  const providers = response.providers.map((provider) => jsonProvider(provider, full));
  return {
    generatedAt: response.generatedAt,
    schemaVersion: response.schemaVersion,
    providers,
    machine: response.machine,
  };
}

function jsonProvider(provider: ProviderQuota, full: boolean): Record<string, unknown> {
  const output: Record<string, unknown> = {
    provider: provider.provider,
    label: provider.label,
    source: provider.source,
    ...(provider.plan ? { plan: provider.plan } : {}),
    windows: provider.windows,
    quotaSemantics: provider.quotaSemantics,
    ...(provider.credits ? { credits: provider.credits } : {}),
    state: provider.state,
  };
  if (provider.pools?.length) {
    output["pools"] = provider.pools.map((pool) => ({
      id: pool.id,
      label: pool.label,
      provider: pool.provider,
      windowIds: pool.windowIds,
      ...(pool.percentRemaining !== undefined ? { percentRemaining: pool.percentRemaining } : {}),
      modelCount: pool.modelCount ?? pool.models?.length ?? 0,
      ...(full && pool.models ? { models: pool.models } : {}),
    }));
  }
  if (full && provider.attempts?.length) output["attempts"] = provider.attempts;
  return output;
}

export function machineJson(machine: MachineCapacity): Record<string, unknown> {
  return { generatedAt: new Date().toISOString(), schemaVersion: 5, machine };
}

export function sourcesJson(reports: SourceReport[]): Record<string, unknown> {
  return { sources: reports };
}
