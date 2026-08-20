import {
  plotResourceProviderCatalog,
  type ConnectorObservation,
  type PlotCommand,
  type PlotProcess,
  type PlotResource,
  type PlotResourceDefinition,
  type PlotResourceKind,
  type PlotResourceProvider,
  type WorkspaceSnapshot,
} from "@silvic/contracts";
export function plotResources({
  workspace,
  commands,
  processes,
  declared,
}: {
  workspace: WorkspaceSnapshot;
  commands: Readonly<Record<string, PlotCommand>>;
  processes: readonly PlotProcess[];
  declared: Readonly<Record<string, PlotResourceDefinition>>;
}): readonly PlotResource[] {
  const plotProcesses = processes.filter(
    (process) => process.plotPath === workspace.path,
  );
  const claimedCommands = new Set(
    Object.values(declared)
      .map((resource) => resource.command)
      .filter((command): command is string => command !== undefined),
  );
  const explicit = Object.entries(declared).map(([id, definition]) =>
    declaredResource(id, definition, plotProcesses),
  );
  const runtime = Object.entries(commands)
    .filter(([id]) => !claimedCommands.has(id))
    .map(([id, command]) => commandResource(id, command, plotProcesses));
  const supervisedProcessIds = new Set(
    plotProcesses
      .map((process) => process.processId)
      .filter((processId): processId is number => processId !== undefined),
  );
  const observed = workspace.observations
    .filter(
      (observation) =>
        observation.kind !== "session" &&
        (observation.kind !== "runtime" ||
          !observationProcessIds(observation).some((processId) =>
            supervisedProcessIds.has(processId),
          )),
    )
    .map(observationResource);
  return [...explicit, ...runtime, ...observed];
}

function observationProcessIds(
  observation: ConnectorObservation,
): readonly number[] {
  const direct = [
    observation.metadata?.processId,
    observation.metadata?.processGroupId,
  ].filter((processId): processId is number => typeof processId === "number");
  const lineage = observation.metadata?.processLineage;
  if (!Array.isArray(lineage)) return direct;
  return [...direct, ...lineage.filter(Number.isSafeInteger)];
}

function declaredResource(
  id: string,
  definition: PlotResourceDefinition,
  processes: readonly PlotProcess[],
): PlotResource {
  const process = definition.command
    ? processes.find((candidate) => candidate.id === definition.command)
    : undefined;
  const url =
    process?.status === "running"
      ? process.url
      : process
        ? undefined
        : definition.url;
  return {
    id: `declared:${id}`,
    provider: definition.provider,
    label: definition.label ?? providerLabel(definition.provider),
    kind: definition.kind,
    isolation: definition.isolation,
    state: definition.command ? processState(process) : "unknown",
    ...(definition.detail ? { detail: definition.detail } : {}),
    ...(url ? { url } : {}),
    ...(definition.dashboardUrl
      ? { dashboardUrl: definition.dashboardUrl }
      : {}),
    ...(definition.command ? { commandId: definition.command } : {}),
  };
}

function commandResource(
  id: string,
  command: PlotCommand,
  processes: readonly PlotProcess[],
): PlotResource {
  const process = processes.find((candidate) => candidate.id === id);
  const provider = providerFor(id, command.run);
  const profile = providerProfile(provider, command.url === true);
  const url = process?.status === "running" ? process.url : undefined;
  return {
    id: `command:${id}`,
    provider,
    label: title(id),
    ...profile,
    state: processState(process),
    detail: process?.advice ?? process?.notice ?? command.run,
    ...(url ? { url } : {}),
    commandId: id,
  };
}

function observationResource(observation: ConnectorObservation): PlotResource {
  const provider = providerFor(observation.connectorId, observation.label);
  const kind = observationKind(observation.kind, provider);
  const dashboardUrl =
    observation.kind !== "runtime" ? observation.url : undefined;
  return {
    id: `observation:${observation.connectorId}:${observation.kind}:${observation.label}`,
    provider,
    label: observation.label,
    kind,
    isolation: providerProfile(provider, false).isolation,
    state: observation.state,
    ...(observation.detail ? { detail: observation.detail } : {}),
    ...(!dashboardUrl && observation.url ? { url: observation.url } : {}),
    ...(dashboardUrl ? { dashboardUrl } : {}),
  };
}

function processState(process: PlotProcess | undefined): PlotResource["state"] {
  if (!process || process.status === "stopped") return "quiet";
  if (process.status === "starting" || process.status === "stopping") {
    return "waiting";
  }
  return process.status === "running" ? "active" : "attention";
}

function providerFor(id: string, detail: string): PlotResourceProvider {
  const value = `${id} ${detail}`.toLowerCase();
  if (value.includes("convex")) return "convex";
  if (value.includes("livekit")) return "livekit";
  if (value.includes("stripe")) return "stripe";
  if (value.includes("cloudflare") || value.includes("wrangler"))
    return "cloudflare";
  if (value.includes("vercel")) return "vercel";
  if (value.includes("clerk")) return "clerk";
  if (value.includes("workos")) return "workos";
  if (value.includes("github")) return "github";
  if (id === "web" || value.includes(" dev")) return "web";
  return "custom";
}

function providerProfile(
  provider: PlotResourceProvider,
  servesUrl: boolean,
): Pick<PlotResourceDefinition, "kind" | "isolation"> {
  if (provider === "custom" && servesUrl) {
    return { kind: "runtime", isolation: "isolated" };
  }
  const { kind, isolation } = plotResourceProviderCatalog[provider];
  return { kind, isolation };
}

function observationKind(
  kind: ConnectorObservation["kind"],
  provider: PlotResourceProvider,
): PlotResourceKind {
  if (provider === "convex") return "backend";
  if (provider === "livekit") return "agent";
  if (kind === "runtime") return "runtime";
  if (kind === "deployment") return "deployment";
  if (kind === "review") return "review";
  if (kind === "authentication") return "auth";
  return "service";
}

function providerLabel(provider: PlotResourceProvider): string {
  return plotResourceProviderCatalog[provider].label;
}

function title(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
