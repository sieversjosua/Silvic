import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { resolvedCommandPath } from "./command-runner";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessListener {
  processId: number;
  port: number;
}

export interface RouteProbe {
  status: number;
  contentType?: string;
}

export interface PublishNamedRouteRequest {
  routeName: string;
  processId: number;
  expectedPort: number;
  /** Recent command output helps distinguish the app from monorepo sidecars. */
  output(): string;
  timeoutMs?: number;
}

export interface PublishedNamedRoute {
  port: number;
}

export interface NamedRoutePublisher {
  publish(request: PublishNamedRouteRequest): Promise<PublishedNamedRoute>;
  healthy(request: { routeName: string; port: number }): Promise<boolean>;
  remove(routeName: string): Promise<void>;
}

interface RoutePublisherOptions {
  execute?(
    executable: string,
    arguments_: readonly string[],
  ): Promise<CommandResult>;
  inspect?(rootProcessId: number): Promise<readonly ProcessListener[]>;
  probe?(url: string): Promise<RouteProbe | undefined>;
  wait?(milliseconds: number): Promise<void>;
  now?(): number;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Publishes the listener that actually came out of a supervised command.
 *
 * A monorepo's root `dev` script often ignores PORT and starts several
 * services. Wrapping that script in portless therefore registers a healthy
 * wrapper against an empty port. Silvic instead owns the two lifecycles
 * separately: it supervises the command tree, finds its responding HTTP
 * listener, and points a Portless alias at that concrete port.
 */
export class PortlessRoutePublisher implements NamedRoutePublisher {
  private readonly execute: NonNullable<RoutePublisherOptions["execute"]>;
  private readonly inspect: NonNullable<RoutePublisherOptions["inspect"]>;
  private readonly probe: NonNullable<RoutePublisherOptions["probe"]>;
  private readonly wait: NonNullable<RoutePublisherOptions["wait"]>;
  private readonly now: NonNullable<RoutePublisherOptions["now"]>;

  constructor(options: RoutePublisherOptions = {}) {
    this.execute = options.execute ?? executeCommand;
    this.inspect = options.inspect ?? inspectProcessListeners;
    this.probe = options.probe ?? probeUrl;
    this.wait = options.wait ?? pause;
    this.now = options.now ?? Date.now;
  }

  async publish(
    request: PublishNamedRouteRequest,
  ): Promise<PublishedNamedRoute> {
    const deadline = this.now() + (request.timeoutMs ?? 45_000);
    let latest =
      "No responding HTTP listener appeared in the runtime process tree.";

    while (true) {
      const listeners = await this.inspect(request.processId);
      const selected = await selectListener({
        listeners,
        expectedPort: request.expectedPort,
        output: request.output(),
        probe: this.probe,
      });
      if (selected) {
        const result = await this.execute("portless", [
          "alias",
          request.routeName,
          String(selected.port),
          "--force",
        ]);
        if (result.exitCode !== 0) {
          throw new Error(
            cleanFailure(result) ||
              "Portless could not publish the preview route.",
          );
        }

        while (this.now() < deadline) {
          if (
            await this.healthy({
              routeName: request.routeName,
              port: selected.port,
            })
          ) {
            return { port: selected.port };
          }
          latest = `Portless registered ${request.routeName}.localhost, but it did not reach localhost:${selected.port}.`;
          await this.wait(Math.min(150, Math.max(0, deadline - this.now())));
        }
      }

      if (this.now() >= deadline) throw new Error(latest);
      await this.wait(Math.min(250, Math.max(0, deadline - this.now())));
    }
  }

  async healthy({
    routeName,
    port,
  }: {
    routeName: string;
    port: number;
  }): Promise<boolean> {
    const [direct, named] = await Promise.all([
      this.probe(`http://127.0.0.1:${port}/`),
      this.probe(`https://${routeName}.localhost/`),
    ]);
    if (!direct || !named || direct.status >= 500 || named.status >= 500) {
      return false;
    }
    // Portless's own missing-route page is a 404. A real app may also use a
    // 404 at its root, so it is healthy only when the upstream agrees.
    if (named.status === 404 && direct.status !== 404) return false;
    return true;
  }

  async remove(routeName: string): Promise<void> {
    await this.execute("portless", ["alias", "--remove", routeName]);
  }
}

async function selectListener({
  listeners,
  expectedPort,
  output,
  probe,
}: {
  listeners: readonly ProcessListener[];
  expectedPort: number;
  output: string;
  probe(url: string): Promise<RouteProbe | undefined>;
}): Promise<ProcessListener | undefined> {
  const announced = new Set(
    [
      ...output.matchAll(
        /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})/gi,
      ),
    ]
      .map((match) => Number(match[1]))
      .filter((port) => port > 0 && port <= 65_535),
  );
  const candidates = await Promise.all(
    listeners.map(async (listener) => ({
      listener,
      response: await probe(`http://127.0.0.1:${listener.port}/`),
    })),
  );

  return candidates
    .filter(
      (
        candidate,
      ): candidate is {
        listener: ProcessListener;
        response: RouteProbe;
      } => candidate.response !== undefined && candidate.response.status < 500,
    )
    .sort((left, right) => {
      const score = (candidate: {
        listener: ProcessListener;
        response: RouteProbe;
      }) =>
        (candidate.listener.port === expectedPort ? 10_000 : 0) +
        (announced.has(candidate.listener.port) ? 1_000 : 0) +
        (candidate.response.contentType?.toLowerCase().includes("text/html")
          ? 100
          : 0) +
        (candidate.response.status >= 200 && candidate.response.status < 400
          ? 10
          : 0);
      return (
        score(right) - score(left) || left.listener.port - right.listener.port
      );
    })[0]?.listener;
}

export function descendantListenerPorts({
  rootProcessId,
  processes,
  listeners,
}: {
  rootProcessId: number;
  processes: readonly (readonly [number, number])[];
  listeners: readonly ProcessListener[];
}): readonly ProcessListener[] {
  const parents = new Map(processes);
  const belongsToTree = (processId: number) => {
    const seen = new Set<number>();
    let current: number | undefined = processId;
    while (current !== undefined && !seen.has(current)) {
      if (current === rootProcessId) return true;
      seen.add(current);
      current = parents.get(current);
    }
    return false;
  };
  return listeners.filter((listener) => belongsToTree(listener.processId));
}

async function inspectProcessListeners(
  rootProcessId: number,
): Promise<readonly ProcessListener[]> {
  const [processes, sockets] = await Promise.all([
    executeCommand("ps", ["-axo", "pid=,ppid="]),
    executeCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]),
  ]);
  const processPairs = processes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (pair): pair is [number, number] =>
        pair.length === 2 && pair.every(Number.isSafeInteger),
    );
  const listeners: ProcessListener[] = [];
  let processId: number | undefined;
  for (const line of sockets.stdout.split(/\r?\n/)) {
    if (line.startsWith("p")) processId = Number(line.slice(1));
    else if (line.startsWith("n") && processId) {
      const port = Number(line.match(/:(\d+)(?:\s|$)/)?.[1]);
      if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
        listeners.push({ processId, port });
      }
    }
  }
  return descendantListenerPorts({
    rootProcessId,
    processes: processPairs,
    listeners: [
      ...new Map(
        listeners.map((listener) => [
          `${listener.processId}:${listener.port}`,
          listener,
        ]),
      ).values(),
    ],
  });
}

function probeUrl(url: string): Promise<RouteProbe | undefined> {
  const target = new URL(url);
  return new Promise((resolve) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        ...(target.port ? { port: target.port } : {}),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { connection: "close", "accept-encoding": "identity" },
        ...(target.protocol === "https:" &&
        target.hostname.endsWith(".localhost")
          ? { rejectUnauthorized: false }
          : {}),
      },
      (response) => {
        response.resume();
        const contentType = response.headers["content-type"];
        resolve({
          status: response.statusCode ?? 0,
          ...(typeof contentType === "string" ? { contentType } : {}),
        });
      },
    );
    request.setTimeout(2_000, () => request.destroy());
    request.once("error", () => resolve(undefined));
    request.end();
  });
}

function executeCommand(
  executable: string,
  arguments_: readonly string[],
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: resolvedCommandPath(),
    };
    if (executable === "portless") {
      // Silvic invokes the resolved CLI directly. Inheriting these markers
      // from a pnpm-started parent makes Portless mistake that direct call for
      // `pnpm dlx` / `npx` and refuse even a globally installed binary.
      delete environment.npm_command;
      delete environment.PNPM_SCRIPT_SRC_DIR;
    }
    execFile(
      executable,
      [...arguments_],
      {
        encoding: "utf8",
        timeout: 4_000,
        maxBuffer: 1_000_000,
        env: environment,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && "code" in error && typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0;
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}

function cleanFailure(result: CommandResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /^error\b/i.test(line)) ?? lines.at(-1) ?? "";
}
