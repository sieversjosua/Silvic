import type {
  Connector,
  ConnectorFailure,
  ConnectorObservation,
  ConnectorResult,
  WorkspaceTarget,
} from "@silvic/contracts";
import {
  connectorManifestSchema,
  connectorObservationSchema,
} from "@silvic/contracts";

export class ConnectorRegistry {
  private readonly connectors: readonly Connector[];

  constructor(connectors: readonly Connector[]) {
    this.connectors = connectors.map((connector) => ({
      ...connector,
      manifest: connectorManifestSchema.parse(connector.manifest),
    }));
  }

  async observe(
    target: WorkspaceTarget,
    signal?: AbortSignal,
  ): Promise<ConnectorResult> {
    const settled = await Promise.allSettled(
      this.connectors.map(async (connector) => ({
        connector,
        observations: await connector.observe(
          target,
          signal ? { signal } : undefined,
        ),
      })),
    );
    const observations: ConnectorObservation[] = [];
    const failures: ConnectorFailure[] = [];

    settled.forEach((result, index) => {
      const connector = this.connectors[index];
      if (!connector) return;
      if (result.status === "fulfilled") {
        try {
          const validated = result.value.observations.map((observation) => {
            const parsed = connectorObservationSchema.parse(observation);
            if (
              parsed.connectorId !== connector.manifest.id ||
              parsed.workspaceId !== target.workspaceId
            ) {
              throw new Error(
                "Connector returned mismatched observation identity",
              );
            }
            return parsed;
          });
          if (validated.length > 100) {
            throw new Error("Connector returned too many observations");
          }
          observations.push(...validated);
        } catch (error) {
          failures.push({
            connectorId: connector.manifest.id,
            message: errorMessage(error),
          });
        }
      } else {
        failures.push({
          connectorId: connector.manifest.id,
          message: errorMessage(result.reason),
        });
      }
    });

    return { observations, failures };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
