import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import type { Connector } from "@silvic/contracts";

import { convexConnector } from "../../../connectors/convex/src/index";
import { createGitHubConnector } from "../../../connectors/github/src/index";
import { createLocalContextConnector } from "../../../connectors/local/src/index";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "./command-runner";

import { LocalCommandRunner } from "./command-runner";
import { ConnectorRegistry } from "./connector-registry";
import { discoverRepositories, ProjectService } from "./project-service";

interface SettingsFile {
  roots?: unknown;
  activeProjects?: unknown;
}

interface CommandMeasurement {
  executable: string;
  operation: string;
  elapsedMs: number;
}

class MeasuringRunner implements CommandRunner {
  readonly measurements: CommandMeasurement[] = [];

  constructor(private readonly runner: CommandRunner) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    const began = performance.now();
    try {
      return await this.runner.run(request);
    } finally {
      this.measurements.push({
        executable: request.executable,
        operation: [request.executable, request.arguments?.[0] ?? ""]
          .filter(Boolean)
          .join(" "),
        elapsedMs: performance.now() - began,
      });
    }
  }
}

class MeasuringConnector implements Connector {
  readonly manifest;
  readonly elapsedMs: number[] = [];

  constructor(private readonly connector: Connector) {
    this.manifest = connector.manifest;
  }

  invalidate = (): void => {
    this.connector.invalidate?.();
  };

  observe = async (
    ...parameters: Parameters<Connector["observe"]>
  ): ReturnType<Connector["observe"]> => {
    const began = performance.now();
    try {
      return await this.connector.observe(...parameters);
    } finally {
      this.elapsedMs.push(performance.now() - began);
    }
  };
}

async function configuredSettings(): Promise<{
  roots: readonly string[];
  activeProjectIds: ReadonlySet<string>;
}> {
  const settingsPath = process.env.SILVIC_SETTINGS_FILE;
  if (!settingsPath) {
    throw new Error(
      "Set SILVIC_SETTINGS_FILE to an Electron settings.json file",
    );
  }
  const settings = JSON.parse(
    await readFile(settingsPath, "utf8"),
  ) as SettingsFile;
  const roots = Array.isArray(settings.roots)
    ? settings.roots.filter((root): root is string => typeof root === "string")
    : [];
  if (roots.length === 0) throw new Error("The settings file has no roots");
  const activeProjectIds = new Set(
    Array.isArray(settings.activeProjects)
      ? settings.activeProjects.filter(
          (project): project is string => typeof project === "string",
        )
      : [],
  );
  return { roots, activeProjectIds };
}

function commandSummary(measurements: readonly CommandMeasurement[]) {
  return Object.entries(
    Object.groupBy(measurements, (entry) => entry.operation),
  )
    .map(([operation, entries]) => ({
      operation,
      count: entries?.length ?? 0,
      cumulativeMs: Math.round(
        entries?.reduce((sum, entry) => sum + entry.elapsedMs, 0) ?? 0,
      ),
    }))
    .sort((left, right) => right.cumulativeMs - left.cumulativeMs);
}

describe("idle refresh performance", () => {
  it.skipIf(!process.env.SILVIC_SETTINGS_FILE)(
    "keeps an unchanged Git-only refresh inside the energy budget",
    async () => {
      const { roots, activeProjectIds } = await configuredSettings();

      const discoveryBegan = performance.now();
      const repositories = await discoverRepositories(roots);
      const discoveryMs = performance.now() - discoveryBegan;

      const runner = new MeasuringRunner(new LocalCommandRunner());
      const service = new ProjectService({
        runner,
        connectors: new ConnectorRegistry([]),
      });
      const coldGitBegan = performance.now();
      await service.snapshot(roots);
      const coldGitMs = performance.now() - coldGitBegan;
      runner.measurements.splice(0);
      const refreshBegan = performance.now();
      const snapshot = await service.snapshot(roots);
      const refreshMs = performance.now() - refreshBegan;
      const workspaces = snapshot.projects.reduce(
        (count, project) => count + project.workspaces.length,
        0,
      );
      const githubWorkspaces = snapshot.projects
        .filter((project) => /github\.com[:/]/i.test(project.origin ?? ""))
        .reduce((count, project) => count + project.workspaces.length, 0);
      const activeWorkspaces = snapshot.projects
        .filter((project) => activeProjectIds.has(project.id))
        .reduce((count, project) => count + project.workspaces.length, 0);
      const commands = commandSummary(runner.measurements);

      console.info(
        "[PERF-idle-refresh]",
        JSON.stringify(
          {
            roots: roots.length,
            repositories: repositories.length,
            projects: snapshot.projects.length,
            workspaces,
            activeProjects: activeProjectIds.size,
            activeWorkspaces,
            githubWorkspaces,
            snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
            discoveryMs: Math.round(discoveryMs),
            coldGitMs: Math.round(coldGitMs),
            refreshMs: Math.round(refreshMs),
            processStarts: runner.measurements.length,
            commands,
          },
          null,
          2,
        ),
      );

      const wallBudgetMs = Number(
        process.env.SILVIC_IDLE_REFRESH_BUDGET_MS ?? 2_000,
      );
      const processStartBudget = Number(
        process.env.SILVIC_IDLE_REFRESH_PROCESS_BUDGET ?? 25,
      );
      expect(refreshMs, "Git-only warm refresh wall time").toBeLessThanOrEqual(
        wallBudgetMs,
      );
      expect(
        runner.measurements.length,
        "external process starts per Git-only warm refresh",
      ).toBeLessThanOrEqual(processStartBudget);
    },
    120_000,
  );

  it.skipIf(
    !process.env.SILVIC_SETTINGS_FILE ||
      process.env.SILVIC_PROFILE_CONNECTORS !== "1",
  )(
    "profiles cold and cached connector enrichment",
    async () => {
      const { roots, activeProjectIds } = await configuredSettings();
      const runner = new MeasuringRunner(new LocalCommandRunner());
      const connectorMeasurements = [
        new MeasuringConnector(createGitHubConnector(runner)),
        new MeasuringConnector(convexConnector),
        new MeasuringConnector(createLocalContextConnector(runner)),
      ];
      const connectors = new ConnectorRegistry(connectorMeasurements);
      const service = new ProjectService({
        runner,
        connectors: new ConnectorRegistry([]),
      });

      const gitBegan = performance.now();
      const snapshot = await service.snapshot(roots);
      const gitMs = performance.now() - gitBegan;
      const gitProcessCount = runner.measurements.length;
      const targets = snapshot.projects
        .filter((project) => activeProjectIds.has(project.id))
        .flatMap((project) =>
          project.workspaces.map((workspace) => ({
            ...workspace,
            ...(project.origin ? { origin: project.origin } : {}),
          })),
        );

      const coldBegan = performance.now();
      await Promise.all(targets.map((target) => connectors.observe(target)));
      const coldMs = performance.now() - coldBegan;
      const coldProcessCount = runner.measurements.length - gitProcessCount;
      const coldConnectorCounts = connectorMeasurements.map(
        (connector) => connector.elapsedMs.length,
      );

      const warmBegan = performance.now();
      await Promise.all(targets.map((target) => connectors.observe(target)));
      const warmMs = performance.now() - warmBegan;
      const warmMeasurements = runner.measurements.slice(
        gitProcessCount + coldProcessCount,
      );

      console.info(
        "[PERF-connector-refresh]",
        JSON.stringify(
          {
            git: {
              wallMs: Math.round(gitMs),
              processStarts: gitProcessCount,
              commands: commandSummary(
                runner.measurements.slice(0, gitProcessCount),
              ),
            },
            cold: {
              wallMs: Math.round(coldMs),
              processStarts: coldProcessCount,
              commands: commandSummary(
                runner.measurements.slice(
                  gitProcessCount,
                  gitProcessCount + coldProcessCount,
                ),
              ),
            },
            cached: {
              wallMs: Math.round(warmMs),
              processStarts: warmMeasurements.length,
              commands: commandSummary(warmMeasurements),
            },
            connectors: connectorMeasurements.map((connector, index) => {
              const coldCount = coldConnectorCounts[index] ?? 0;
              return {
                connector: connector.manifest.id,
                coldCalls: coldCount,
                coldCumulativeMs: Math.round(
                  connector.elapsedMs
                    .slice(0, coldCount)
                    .reduce((sum, elapsedMs) => sum + elapsedMs, 0),
                ),
                cachedCalls: connector.elapsedMs.length - coldCount,
                cachedCumulativeMs: Math.round(
                  connector.elapsedMs
                    .slice(coldCount)
                    .reduce((sum, elapsedMs) => sum + elapsedMs, 0),
                ),
              };
            }),
          },
          null,
          2,
        ),
      );

      expect(coldMs).toBeGreaterThan(0);
      expect(warmMs).toBeGreaterThan(0);
    },
    180_000,
  );
});
