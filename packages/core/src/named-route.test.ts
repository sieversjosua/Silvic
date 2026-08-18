import { describe, expect, it, vi } from "vitest";

import {
  GateRoutePublisher,
  descendantListenerPorts,
  type GateRouteLink,
} from "./named-route";

const recordingLink = () => {
  const routes = new Map<string, { host: string; port: number }>();
  const link: GateRouteLink = {
    set: vi.fn(async (route) => {
      routes.set(route.name, { host: route.host, port: route.port });
    }),
    suspend: vi.fn(async (name: string) => {
      routes.delete(name);
    }),
  };
  return { link, routes };
};

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

describe("GateRoutePublisher", () => {
  it("publishes the announced HTML listener when a monorepo ignores PORT", async () => {
    const { link } = recordingLink();
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
    const publisher = new GateRoutePublisher({
      link,
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
      plotPath: "/plots/mono-cmd-k-menu",
      commandId: "web",
    });

    expect(published).toEqual({ port: 4321 });
    expect(link.set).toHaveBeenCalledWith({
      name: "web-cmd-k-menu-mono",
      host: "127.0.0.1",
      port: 4321,
      plotPath: "/plots/mono-cmd-k-menu",
      commandId: "web",
    });
  });

  it("does not publish a plain-text sidecar that happens to claim PORT", async () => {
    const { link } = recordingLink();
    const probe = vi.fn(async (url: string) => {
      if (url === "http://127.0.0.1:8691/") {
        return { status: 200, contentType: "text/plain" };
      }
      if (url === "http://127.0.0.1:4321/") {
        return { status: 200, contentType: "text/html; charset=utf-8" };
      }
      if (url === "https://web-cmd-k-menu-mono.localhost/") {
        return { status: 200, contentType: "text/html; charset=utf-8" };
      }
      return undefined;
    });
    const publisher = new GateRoutePublisher({
      link,
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
    expect(link.set).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4321 }),
    );
  });

  it("adopts an announced existing web server instead of a descendant health check", async () => {
    const { link, routes } = recordingLink();
    const probe = vi.fn(async (url: string) => {
      if (url === "http://127.0.0.1:49731/") {
        return { status: 200 };
      }
      if (url === "http://127.0.0.1:4060/") {
        return { status: 200, contentType: "text/html; charset=utf-8" };
      }
      if (url === "https://web-cmd-k-menu-mono.localhost/") {
        return routes.get("web-cmd-k-menu-mono")?.port === 4060
          ? { status: 200, contentType: "text/html; charset=utf-8" }
          : { status: 200 };
      }
      return undefined;
    });
    const publisher = new GateRoutePublisher({
      link,
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
    expect(link.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: "web-cmd-k-menu-mono", port: 4060 }),
    );
  });

  it("prefers a descendant web server to a stale announced server", async () => {
    const { link, routes } = recordingLink();
    const probe = vi.fn(async (url: string) => {
      if (
        url === "http://127.0.0.1:4321/" ||
        url === "http://127.0.0.1:4322/"
      ) {
        return { status: 200, contentType: "text/html; charset=utf-8" };
      }
      if (url === "https://web-color-scheme-mono.localhost/") {
        return routes.has("web-color-scheme-mono")
          ? { status: 200, contentType: "text/html; charset=utf-8" }
          : undefined;
      }
      return undefined;
    });
    const publisher = new GateRoutePublisher({
      link,
      probe,
      // Only 4322 belongs to the command Silvic just started. Port 4321 is an
      // old Astro URL retained in the multi-service runner's recent output.
      inspect: async () => [{ processId: 52002, port: 4322 }],
      wait: async () => undefined,
    });

    const published = await publisher.publish({
      routeName: "web-color-scheme-mono",
      processId: 52000,
      expectedPort: 8691,
      output: () => "[astro] Previous URL: http://localhost:4321/",
      timeoutMs: 10,
    });

    expect(published).toEqual({ port: 4322 });
    expect(link.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: "web-color-scheme-mono", port: 4322 }),
    );
  });

  it("refuses to publish a health endpoint when no web server appears", async () => {
    let elapsed = 0;
    const { link } = recordingLink();
    const publisher = new GateRoutePublisher({
      link,
      inspect: async () => [{ processId: 38304, port: 49731 }],
      probe: async () => ({
        status: 200,
        contentType: "text/plain; charset=utf-8",
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
    expect(link.set).not.toHaveBeenCalled();
  });

  it("publishes an HTML error page from the real web server", async () => {
    let elapsed = 0;
    const { link } = recordingLink();
    const publisher = new GateRoutePublisher({
      link,
      inspect: async () => [{ processId: 36926, port: 4321 }],
      probe: async (url) =>
        url.includes(":4321/") ||
        url === "https://web-mcp-upgrades-mono.localhost/"
          ? { status: 500, contentType: "text/html; charset=utf-8" }
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

  it("suspends rather than deletes a route when a command stops", async () => {
    const { link } = recordingLink();
    const publisher = new GateRoutePublisher({
      link,
      inspect: async () => [],
      probe: async () => undefined,
      wait: async () => undefined,
    });
    await publisher.remove("web-cmd-k-menu-mono");
    expect(link.suspend).toHaveBeenCalledWith("web-cmd-k-menu-mono");
  });

  it("does not call a gate 503 or missing route healthy", async () => {
    const namedStatus = { current: 503 };
    const { link } = recordingLink();
    const publisher = new GateRoutePublisher({
      link,
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
    const { link } = recordingLink();
    const publisher = new GateRoutePublisher({
      link,
      inspect: async () => [],
      probe: async (url) =>
        url.startsWith("http://127.0.0.1")
          ? { status: 200, contentType: "text/html; charset=utf-8" }
          : { status: 200, contentType: "text/plain" },
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
    const { link } = recordingLink();
    const publisher = new GateRoutePublisher({
      link,
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
