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

  it("does not publish a plain-text sidecar that happens to claim PORT", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "Alias registered",
      stderr: "",
    });
    const probe = vi.fn(async (url: string) => {
      if (url === "http://127.0.0.1:8691/") {
        return { status: 200, contentType: "text/plain", body: "OK" };
      }
      if (url === "http://127.0.0.1:4321/") {
        return {
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><title>Web app</title>",
        };
      }
      if (url === "https://web-cmd-k-menu-mono.localhost/") {
        return {
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><title>Web app</title>",
        };
      }
      return undefined;
    });
    const publisher = new PortlessRoutePublisher({
      execute,
      probe,
      inspect: async () => [
        { processId: 201, port: 8691 },
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

  it("adopts an announced existing web server instead of a descendant health check", async () => {
    let aliasedPort: number | undefined;
    const execute = vi
      .fn()
      .mockImplementation(
        async (_executable: string, arguments_: readonly string[]) => {
          aliasedPort = Number(arguments_[2]);
          return {
            exitCode: 0,
            stdout: "Alias registered",
            stderr: "",
          };
        },
      );
    const probe = vi.fn(async (url: string) => {
      if (url === "http://127.0.0.1:49731/") {
        return { status: 200, body: "OK" };
      }
      if (url === "http://127.0.0.1:4060/") {
        return {
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><title>SynTwin</title>",
        };
      }
      if (url === "https://web-cmd-k-menu-mono.localhost/") {
        return aliasedPort === 4060
          ? {
              status: 200,
              contentType: "text/html; charset=utf-8",
              body: "<!doctype html><title>SynTwin</title>",
            }
          : { status: 200, body: "OK" };
      }
      return undefined;
    });
    const publisher = new PortlessRoutePublisher({
      execute,
      probe,
      // The existing Astro server is outside the newly started command tree;
      // only LiveKit's health listener is a descendant.
      inspect: async () => [{ processId: 38304, port: 49731 }],
      wait: async () => undefined,
    });

    const published = await publisher.publish({
      routeName: "web-cmd-k-menu-mono",
      processId: 38207,
      expectedPort: 8691,
      output: () =>
        [
          "[livekit] Server is listening on port 49731",
          "[astro] Another astro dev server is already running.",
          "[astro] URL: http://127.0.0.1:4060",
        ].join("\n"),
      timeoutMs: 10,
    });

    expect(published).toEqual({ port: 4060 });
    expect(execute).toHaveBeenCalledWith("portless", [
      "alias",
      "web-cmd-k-menu-mono",
      "4060",
      "--force",
    ]);
  });

  it("refuses to publish a health endpoint when no web server appears", async () => {
    let elapsed = 0;
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "Alias registered",
      stderr: "",
    });
    const publisher = new PortlessRoutePublisher({
      execute,
      inspect: async () => [{ processId: 38304, port: 49731 }],
      probe: async () => ({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        body: "OK",
      }),
      now: () => elapsed,
      wait: async (milliseconds) => {
        elapsed += milliseconds;
      },
    });

    await expect(
      publisher.publish({
        routeName: "web-cmd-k-menu-mono",
        processId: 38207,
        expectedPort: 8691,
        output: () => "[livekit] Server is listening on port 49731",
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/browser-facing HTML listener/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("publishes an HTML error page from the real web server", async () => {
    let elapsed = 0;
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "Alias registered",
      stderr: "",
    });
    const publisher = new PortlessRoutePublisher({
      execute,
      inspect: async () => [{ processId: 36926, port: 4321 }],
      probe: async (url) =>
        url.includes(":4321/") ||
        url === "https://web-mcp-upgrades-mono.localhost/"
          ? {
              status: 500,
              contentType: "text/html; charset=utf-8",
              body: "<title>Error</title>",
            }
          : undefined,
      now: () => elapsed,
      wait: async (milliseconds) => {
        elapsed += milliseconds;
      },
    });

    await expect(
      publisher.publish({
        routeName: "web-mcp-upgrades-mono",
        processId: 36850,
        expectedPort: 7090,
        output: () => "Local: http://localhost:4321",
        timeoutMs: 10,
      }),
    ).resolves.toEqual({ port: 4321 });
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

  it("does not call a named route healthy when it serves OK instead of the app", async () => {
    const publisher = new PortlessRoutePublisher({
      execute: vi.fn(),
      inspect: async () => [],
      probe: async (url) =>
        url.startsWith("http://127.0.0.1")
          ? {
              status: 200,
              contentType: "text/html; charset=utf-8",
              body: "<!doctype html><title>Web app</title>",
            }
          : { status: 200, contentType: "text/plain", body: "OK" },
      wait: async () => undefined,
    });

    await expect(
      publisher.healthy({
        routeName: "web-cmd-k-menu-mono",
        port: 4321,
      }),
    ).resolves.toBe(false);
  });

  it("does not call matching empty 404 endpoints a healthy web preview", async () => {
    const publisher = new PortlessRoutePublisher({
      execute: vi.fn(),
      inspect: async () => [],
      probe: async () => ({ status: 404 }),
      wait: async () => undefined,
    });

    await expect(
      publisher.healthy({
        routeName: "web-mcp-upgrades-mono",
        port: 9236,
      }),
    ).resolves.toBe(false);
  });
});
