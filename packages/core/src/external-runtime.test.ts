import { describe, expect, it } from "vitest";

import {
  astroDuplicateServerEvidence,
  identifyExternalServer,
} from "./external-runtime";

describe("astroDuplicateServerEvidence", () => {
  it("parses Astro's duplicate-server refusal", () => {
    expect(
      astroDuplicateServerEvidence(
        [
          "bun run dev:web",
          "$ astro dev",
          "Another astro dev server is already running.",
          "URL: http://127.0.0.1:4375",
          "PID: 16056",
          "Run `astro dev stop` to stop it, or use `astro dev --force` to replace it.",
          'error: script "dev:web" exited with code 1',
        ].join("\n"),
      ),
    ).toEqual({ hostname: "127.0.0.1", port: 4375, processId: 16056 });
  });

  it("parses prefixed multi-service output and extra spacing", () => {
    expect(
      astroDuplicateServerEvidence(
        [
          "[astro] Another astro dev server is already running.",
          "[astro]   URL:  http://[::1]:4328",
          "[astro]   PID:  90210",
        ].join("\n"),
      ),
    ).toEqual({ hostname: "::1", port: 4328, processId: 90210 });
  });

  it("uses the newest refusal when the log holds an older one", () => {
    expect(
      astroDuplicateServerEvidence(
        [
          "Another astro dev server is already running.",
          "URL: http://127.0.0.1:4100",
          "PID: 111",
          "…later…",
          "Another astro dev server is already running.",
          "URL: http://127.0.0.1:4200",
          "PID: 222",
        ].join("\n"),
      ),
    ).toEqual({ hostname: "127.0.0.1", port: 4200, processId: 222 });
  });

  it("yields nothing without the banner, the URL, or the PID", () => {
    expect(
      astroDuplicateServerEvidence("Local: http://localhost:4321/"),
    ).toBeUndefined();
    expect(
      astroDuplicateServerEvidence(
        "Another astro dev server is already running.\nPID: 16056",
      ),
    ).toBeUndefined();
    expect(
      astroDuplicateServerEvidence(
        "Another astro dev server is already running.\nURL: http://127.0.0.1:4375",
      ),
    ).toBeUndefined();
  });

  it("refuses PIDs and ports that can never be a dev server", () => {
    expect(
      astroDuplicateServerEvidence(
        "Another astro dev server is already running.\nURL: http://127.0.0.1:4375\nPID: 1",
      ),
    ).toBeUndefined();
    expect(
      astroDuplicateServerEvidence(
        "Another astro dev server is already running.\nURL: http://127.0.0.1:99999\nPID: 4567",
      ),
    ).toBeUndefined();
  });

  it("does not borrow a URL printed long after the banner", () => {
    expect(
      astroDuplicateServerEvidence(
        `Another astro dev server is already running.\n${"x".repeat(700)}\nURL: http://127.0.0.1:4375\nPID: 16056`,
      ),
    ).toBeUndefined();
  });
});

describe("identifyExternalServer", () => {
  const evidence = { hostname: "127.0.0.1", port: 4375, processId: 16056 };

  const machine = (state: {
    alive?: boolean;
    sockets?: string;
    cwd?: string;
    command?: string;
  }) => ({
    execute: async (executable: string, args: readonly string[]) => {
      if (executable === "ps" && args.includes("pid=")) {
        return { exitCode: 0, stdout: state.alive === false ? "" : "16056\n" };
      }
      if (executable === "lsof" && args.includes("-sTCP:LISTEN")) {
        return { exitCode: 0, stdout: state.sockets ?? "" };
      }
      if (executable === "lsof" && args.includes("cwd")) {
        return {
          exitCode: 0,
          stdout: state.cwd ? `p16056\nfcwd\nn${state.cwd}\n` : "",
        };
      }
      if (executable === "ps" && args.includes("command=")) {
        return { exitCode: 0, stdout: `${state.command ?? ""}\n` };
      }
      throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
    },
    resolvePath: async (path: string) => path,
  });

  it("verifies a live listener whose cwd is inside the plot", async () => {
    await expect(
      identifyExternalServer(
        evidence,
        "/workspace/mono.plots/mono-tags-upgrade",
        machine({
          sockets: "p16056\nn127.0.0.1:4375\n",
          cwd: "/workspace/mono.plots/mono-tags-upgrade/apps/web",
        }),
      ),
    ).resolves.toEqual({
      verdict: "verified",
      families: ["127.0.0.1"],
      workingDirectory: "/workspace/mono.plots/mono-tags-upgrade/apps/web",
    });
  });

  it("verifies through the command path when the cwd is elsewhere", async () => {
    await expect(
      identifyExternalServer(
        evidence,
        "/workspace/mono.plots/mono-tags-upgrade",
        machine({
          sockets: "p16056\nn[::1]:4375\n",
          cwd: "/workspace",
          command:
            "node /workspace/mono.plots/mono-tags-upgrade/node_modules/.bin/astro dev",
        }),
      ),
    ).resolves.toEqual({
      verdict: "verified",
      families: ["::1"],
      workingDirectory: "/workspace",
    });
  });

  it("reports both loopback families for a wildcard listener", async () => {
    await expect(
      identifyExternalServer(
        evidence,
        "/plot",
        machine({ sockets: "p16056\nn*:4375\n", cwd: "/plot" }),
      ),
    ).resolves.toMatchObject({ families: ["127.0.0.1", "::1"] });
  });

  it("calls a dead process gone", async () => {
    await expect(
      identifyExternalServer(evidence, "/plot", machine({ alive: false })),
    ).resolves.toEqual({
      verdict: "gone",
      detail: "the reported process 16056 is not running any more",
    });
  });

  it("calls a process that lost the port gone", async () => {
    await expect(
      identifyExternalServer(evidence, "/plot", machine({ sockets: "" })),
    ).resolves.toEqual({
      verdict: "gone",
      detail: "process 16056 no longer listens on port 4375",
    });
  });

  it("calls another worktree's listener foreign", async () => {
    await expect(
      identifyExternalServer(
        evidence,
        "/workspace/mono.plots/mono-tags-upgrade",
        machine({
          sockets: "p16056\nn[::1]:4375\n",
          cwd: "/workspace/syntwin-mono.worktrees/prototype-grow-v1-owner-flow",
          command:
            "node /workspace/syntwin-mono.worktrees/prototype-grow-v1-owner-flow/node_modules/.bin/astro dev",
        }),
      ),
    ).resolves.toEqual({
      verdict: "foreign",
      detail:
        "process 16056 runs in /workspace/syntwin-mono.worktrees/prototype-grow-v1-owner-flow, which is not inside this plot",
    });
  });

  it("treats unprovable identity as foreign rather than attachable", async () => {
    await expect(
      identifyExternalServer(
        evidence,
        "/plot",
        machine({ sockets: "p16056\nn127.0.0.1:4375\n" }),
      ),
    ).resolves.toEqual({
      verdict: "foreign",
      detail: "Silvic could not prove that process 16056 belongs to this plot",
    });
  });

  it("does not mistake a sibling directory for the plot", async () => {
    await expect(
      identifyExternalServer(
        evidence,
        "/workspace/mono.plots/mono-tags",
        machine({
          sockets: "p16056\nn127.0.0.1:4375\n",
          cwd: "/workspace/mono.plots/mono-tags-upgrade",
        }),
      ),
    ).resolves.toMatchObject({ verdict: "foreign" });
  });

  it("compares symlinked paths by their real location", async () => {
    const resolvePath = async (path: string) =>
      path.replace(/^\/var\//, "/private/var/");
    await expect(
      identifyExternalServer(evidence, "/var/plots/tags-upgrade", {
        ...machine({
          sockets: "p16056\nn127.0.0.1:4375\n",
          cwd: "/private/var/plots/tags-upgrade/apps/web",
        }),
        resolvePath,
      }),
    ).resolves.toMatchObject({ verdict: "verified" });
  });
});
