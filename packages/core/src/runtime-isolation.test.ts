import { describe, expect, it } from "vitest";

import {
  reserveRuntimeSidePort,
  runtimeIsolationEnvironment,
} from "./runtime-isolation";

const resources = {
  agent: {
    provider: "livekit" as const,
    kind: "agent" as const,
    isolation: "shared" as const,
    command: "agent",
  },
  cloudflare: {
    provider: "cloudflare" as const,
    kind: "ingress" as const,
    isolation: "manual" as const,
    command: "web",
  },
};

describe("runtime isolation", () => {
  it("reserves unique main and inspector ports and agent identities for five parallel Plots", () => {
    const taken = new Set([3_101, 3_102, 3_103, 3_104, 3_105]);
    const environments = Array.from({ length: 5 }, (_, index) => {
      const attemptId = `workspace_attempt_${index}`;
      const port = reserveRuntimeSidePort(`${attemptId}/agent/port`, taken);
      const inspectorPort = reserveRuntimeSidePort(
        `${attemptId}/agent/inspector`,
        taken,
      );
      return runtimeIsolationEnvironment({
        project: "any-project",
        plot: `parallel-${index}`,
        attemptId,
        commandId: "agent",
        port,
        inspectorPort,
        resources,
      });
    });

    const allPorts = environments.flatMap((environment) => [
      environment["SILVIC_RUNTIME_PORT"],
      environment["SILVIC_INSPECTOR_PORT"],
    ]);
    expect(new Set(allPorts).size).toBe(10);
    expect(
      new Set(environments.map((environment) => environment.LIVEKIT_AGENT_NAME))
        .size,
    ).toBe(5);
    expect(allPorts.map(Number)).not.toContain(23_101);
  });

  it("returns the same reservation and environment inputs idempotently", () => {
    const firstTaken = new Set<number>();
    const secondTaken = new Set<number>();
    const firstPort = reserveRuntimeSidePort("attempt/agent/port", firstTaken);
    const secondPort = reserveRuntimeSidePort(
      "attempt/agent/port",
      secondTaken,
    );
    const input = {
      project: "project",
      plot: "plot",
      attemptId: "attempt",
      commandId: "agent",
      port: firstPort,
      inspectorPort: reserveRuntimeSidePort(
        "attempt/agent/inspector",
        firstTaken,
      ),
      resources,
    } as const;

    expect(secondPort).toBe(firstPort);
    expect(runtimeIsolationEnvironment(input)).toEqual(
      runtimeIsolationEnvironment(input),
    );
  });

  it("protects injected identity and inspector settings without exposing credentials", () => {
    const environment = runtimeIsolationEnvironment({
      project: "project",
      plot: "plot",
      attemptId: "attempt",
      commandId: "agent",
      port: 31_111,
      inspectorPort: 31_112,
      resources,
      nodeOptions: "--max-old-space-size=4096 --inspect-port=9231",
    });

    expect(environment).toMatchObject({
      SILVIC_ATTEMPT_ID: "attempt",
      SILVIC_RUNTIME_ID: "agent",
      PORT: "31111",
      SILVIC_RUNTIME_PORT: "31111",
      SILVIC_INSPECTOR_PORT: "31112",
      LIVEKIT_AGENT_NAME: expect.stringMatching(/^project-plot-agent-/),
      NODE_OPTIONS: "--max-old-space-size=4096 --inspect-port=31112",
    });
    expect(JSON.stringify(environment)).not.toMatch(/SECRET|TOKEN|KEY/);
  });
});
