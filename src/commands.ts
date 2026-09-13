import { collectUsage } from "./sources/index.js";
import { measureMachine } from "./sources/machine.js";
import { parseFlags } from "./args.js";
import {
  doctorJson,
  machineJson,
  renderDoctorToon,
  renderMachineToon,
  renderSourcesToon,
  renderUsageToon,
  sourcesJson,
  toJsonObject,
  type DoctorCheck,
} from "./render.js";
import type { SourceReport, UsageResponse } from "./types.js";

type Context = { binPath: string };

export async function quotaCommand(args: string[], context: Context | undefined): Promise<string> {
  const binPath = context?.binPath ?? "usage-axi";
  const flags = parseFlags(args);
  const { response, reports } = await collectUsage({ force: flags.force, ...(flags.providers ? { providers: flags.providers } : {}) });
  if (everyProviderFailed(response)) process.exitCode = 1;
  if (flags.json) return `${JSON.stringify(toJsonObject(response, flags.full, reports), null, 2)}\n`;
  return renderUsageToon(response, binPath, flags.full, reports);
}

export async function machineCommand(args: string[], context: Context | undefined): Promise<string> {
  const binPath = context?.binPath ?? "usage-axi";
  const flags = parseFlags(args);
  const machine = await measureMachine();
  if (flags.json) return `${JSON.stringify(machineJson(machine), null, 2)}\n`;
  return renderMachineToon(machine, binPath);
}

export async function sourcesCommand(args: string[], context: Context | undefined): Promise<string> {
  const binPath = context?.binPath ?? "usage-axi";
  const flags = parseFlags(args);
  const { reports } = await collectUsage({ force: flags.force });
  if (flags.json) return `${JSON.stringify(sourcesJson(reports), null, 2)}\n`;
  return renderSourcesToon(reports, binPath);
}

export async function doctorCommand(args: string[], context: Context | undefined): Promise<string> {
  const binPath = context?.binPath ?? "usage-axi";
  const flags = parseFlags(args);
  const { reports, response } = await collectUsage({ force: flags.force });
  const checks = buildDoctorChecks(reports, response, response.machine.memoryFreePct !== null);
  if (!checks.some((check) => check.check === "usage-source" && check.status === "ok")) {
    process.exitCode = 1;
  }
  if (flags.json) return `${JSON.stringify(doctorJson(checks), null, 2)}\n`;
  return renderDoctorToon(checks, binPath);
}

function everyProviderFailed(response: UsageResponse): boolean {
  return (
    response.providers.length > 0 &&
    response.providers.every((provider) => !["fresh", "stale"].includes(provider.state.status))
  );
}

function buildDoctorChecks(
  reports: SourceReport[],
  response: UsageResponse,
  machineMeasured: boolean,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const openusage = reports.find((report) => report.source === "openusage");
  const quotaAxi = reports.find((report) => report.source === "quota-axi");
  const catalog = reports.find((report) => report.source === "opencode-catalog");

  const usageOk = openusage?.status === "available" || quotaAxi?.status === "available";
  checks.push({
    check: "usage-source",
    status: usageOk ? "ok" : "fail",
    detail: usageOk
      ? `providers=${response.providers.length}`
      : "neither openusage nor quota-axi returned data",
  });
  checks.push({
    check: "openusage",
    status: openusage?.status === "available" ? "ok" : "warn",
    detail: openusage?.detail ?? "unknown",
  });
  checks.push({
    check: "quota-axi",
    status: quotaAxi?.status === "available" ? "ok" : "warn",
    detail: quotaAxi?.detail ?? "unknown",
  });
  checks.push({
    check: "opencode-catalog",
    status: catalog?.status === "available" ? "ok" : "warn",
    detail: catalog?.detail ?? "unknown",
  });
  checks.push({
    check: "machine",
    status: machineMeasured ? "ok" : "warn",
    detail: machineMeasured ? "memory measured" : "memory reading unavailable",
  });
  const fresh = response.providers.filter((provider) => provider.state.status === "fresh").length;
  checks.push({
    check: "fresh-providers",
    status: fresh > 0 ? "ok" : "warn",
    detail: `${fresh} of ${response.providers.length} providers fresh`,
  });
  return checks;
}
