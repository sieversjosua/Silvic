import { describe, expect, it, vi } from "vitest";

import { PortlessRoutePublisher, descendantListenerPorts } from "./named-route";

describe("descendantListenerPorts", () => {
  it("keeps listeners owned by the supervised process tree", () => {
    expect(
      descendantListenerPorts({
        rootProcessId: 100,
        processes: [
          [100, 1],
          [101, 100],
          [102, 101],
          [900, 1],
        ],
        listeners: [
          { processId: 102, port: 4321 },
          { processId: 900, port: 8080 },
        ],
      }),
    ).toEqual([{ processId: 102, port: 4321 }]);
  });
});

describe("PortlessRoutePublisher", () => {
  it("publishes the announced HTML listener when a monorepo ignores PORT", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "Alias registered",
      stderr: "",
    });
    const probe = vi.fn(async (url: string) => {
      if (url === "http://127.0.0.1:4321/") {
        return { status: 200, contentType: "text/html; charset=utf-8" };
      }
      if (url === "http://127.0.0.1:55341/") {
        return { status: 200, contentType: "application/json" };
      }
      if (url === "https://web-cmd-k-menu-mono.localhost/") {
        return { status: 200, contentType: "text/html; charset=utf-8" };
      }
      return undefined;
    });
    const publisher = new PortlessRoutePublisher({
      execute,
      probe,
      inspect: async () => [
        { processId: 201, port: 55341 },
        { processId: 202, port: 4321 },
      ],
      wait: async () => undefined,
    });

    const published = await publisher.publish({
      routeName: "web-cmd-k-menu-mono",
      processId: 200,
      expectedPort: 8691,
      output: () => "Local: http://localhost:4321",
      timeoutMs: 10,
    });

    expect(published).toEqual({ port: 4321 });
    expect(execute).toHaveBeenCalledWith("portless", [
      "alias",
      "web-cmd-k-menu-mono",
      "4321",
      "--force",
    ]);
  });

  it("does not call a Portless 502 or missing route healthy", async () => {
    const namedStatus = { current: 502 };
    const publisher = new PortlessRoutePublisher({
      execute: vi.fn(),
      inspect: async () => [],
      probe: async (url) =>
        url.startsWith("http://127.0.0.1")
          ? { status: 200, contentType: "text/html" }
          : { status: namedStatus.current, contentType: "text/html" },
      wait: async () => undefined,
    });

    await expect(
      publisher.healthy({
        routeName: "web-cmd-k-menu-mono",
        port: 4321,
      }),
    ).resolves.toBe(false);
    namedStatus.current = 404;
    await expect(
      publisher.healthy({
        routeName: "web-cmd-k-menu-mono",
        port: 4321,
      }),
    ).resolves.toBe(false);
  });
});
