import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { resolvedCommandPath } from "./command-runner";

/**
 * A launcher's report that the runtime it was asked to start already exists.
 *
 * Console text is not authority: any retained URL in a log tail can point at a
 * port that has since been taken by an unrelated process — even one serving a
 * different worktree's branch. Evidence is only collected from launchers that
 * name both the URL and the owning PID, and it still has to pass
 * `identifyExternalServer` before Silvic will route it.
 */
export interface ExternalServerEvidence {
  hostname: string;
  port: number;
  processId: number;
}

export type LoopbackFamily = "127.0.0.1" | "::1";

export type ExternalServerIdentity =
  | {
      verdict: "verified";
      /** Loopback families the process actually listens on for that port. */
      families: readonly LoopbackFamily[];
      /** Where the process runs, when it could be read. */
      workingDirectory?: string;
    }
  /** The reported process is gone, or it no longer holds the reported port. */
  | { verdict: "gone"; detail: string }
  /** The process is real but provably or unprovably not this plot's. */
  | { verdict: "foreign"; detail: string };

/**
 * Astro refuses a duplicate `astro dev` launch with unusually strong evidence:
 *
 *     Another astro dev server is already running.
 *     URL: http://127.0.0.1:4375
 *     PID: 16056
 *     Run `astro dev stop` to stop it, or use `astro dev --force` to replace it.
 *
 * The last occurrence wins, since a restarted launcher appends to its log.
 */
export function astroDuplicateServerEvidence(
  output: string,
): ExternalServerEvidence | undefined {
  const banner = output.lastIndexOf(
    "Another astro dev server is already running",
  );
  if (banner === -1) return undefined;
  // A bounded window after the banner, so an old refusal cannot borrow the
  // URL or PID of unrelated text printed much later.
  const window = output.slice(banner, banner + 600);
  const url = /URL:\s*(https?:\/\/\S+)/i.exec(window)?.[1];
  const pid = /PID:\s*(\d{1,9})\b/i.exec(window)?.[1];
  if (!url || !pid) return undefined;
  try {
    const parsed = new URL(url);
    const port = Number(
      parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    );
    const processId = Number(pid);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
      return undefined;
    }
    // PID 0/1 can never be a dev server; refusing them here keeps the
    // verifier from ever asking the kernel about the launchd process.
    if (!Number.isSafeInteger(processId) || processId <= 1) return undefined;
    return {
      hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
      port,
      processId,
    };
  } catch {
    return undefined;
  }
}

interface CommandResult {
  exitCode: number;
  stdout: string;
}

export interface IdentifyExternalServerOptions {
  execute?(executable: string, args: readonly string[]): Promise<CommandResult>;
  /** Follows symlinks so `/var` and `/private/var` compare as one place. */
  resolvePath?(path: string): Promise<string>;
}

/**
 * Whether the reported process is the plot's own runtime. Three facts have to
 * hold before an announced server may receive the plot's canonical route:
 * the PID is alive, it owns the reported listening port, and it runs inside
 * the selected plot's worktree. A listener that fails the third check is
 * serving another branch's code — routing it would silently publish the wrong
 * application under the right URL, which is worse than any startup failure.
 */
export async function identifyExternalServer(
  evidence: ExternalServerEvidence,
  plotPath: string,
  options: IdentifyExternalServerOptions = {},
): Promise<ExternalServerIdentity> {
  const execute = options.execute ?? executeCommand;
  const resolvePath =
    options.resolvePath ??
    (async (path: string) => {
      try {
        return await realpath(path);
      } catch {
        return path;
      }
    });
  const processId = String(evidence.processId);

  const alive = await execute("ps", ["-p", processId, "-o", "pid="]);
  if (!alive.stdout.trim()) {
    return {
      verdict: "gone",
      detail: `the reported process ${processId} is not running any more`,
    };
  }

  const sockets = await execute("lsof", [
    "-nP",
    "-a",
    "-p",
    processId,
    `-iTCP:${evidence.port}`,
    "-sTCP:LISTEN",
    "-Fn",
  ]);
  const families = listeningFamilies(sockets.stdout);
  if (families.length === 0) {
    return {
      verdict: "gone",
      detail: `process ${processId} no longer listens on port ${evidence.port}`,
    };
  }

  const root = await resolvePath(resolve(plotPath));
  const within = async (path: string) => {
    const relation = relative(root, await resolvePath(path));
    return (
      relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))
    );
  };

  const cwdReport = await execute("lsof", [
    "-a",
    "-p",
    processId,
    "-d",
    "cwd",
    "-Fn",
  ]);
  const workingDirectory = cwdReport.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  if (workingDirectory && (await within(workingDirectory))) {
    return { verdict: "verified", families, workingDirectory };
  }

  // A monorepo tool can run from the repository root while its executable
  // lives in the worktree: `node <worktree>/node_modules/.bin/astro dev`.
  const command = (
    await execute("ps", ["-p", processId, "-o", "command="])
  ).stdout.trim();
  for (const token of command.split(/\s+/)) {
    if (isAbsolute(token) && (await within(token))) {
      return {
        verdict: "verified",
        families,
        ...(workingDirectory ? { workingDirectory } : {}),
      };
    }
  }

  return {
    verdict: "foreign",
    detail: workingDirectory
      ? `process ${processId} runs in ${workingDirectory}, which is not inside this plot`
      : `Silvic could not prove that process ${processId} belongs to this plot`,
  };
}

/** lsof `-Fn` names: `127.0.0.1:4375`, `[::1]:4328`, `*:4375`, `[::]:4375`. */
function listeningFamilies(report: string): readonly LoopbackFamily[] {
  const families = new Set<LoopbackFamily>();
  for (const line of report.split(/\r?\n/)) {
    if (!line.startsWith("n")) continue;
    const name = line.slice(1);
    if (name.startsWith("127.0.0.1:") || name.startsWith("0.0.0.0:")) {
      families.add("127.0.0.1");
    } else if (name.startsWith("[::1]:")) {
      families.add("::1");
    } else if (name.startsWith("*:") || name.startsWith("[::]:")) {
      families.add("127.0.0.1");
      families.add("::1");
    }
  }
  // The v4 loopback first: it is what launchers print and what the gate
  // reaches without a family bridge.
  return (["127.0.0.1", "::1"] as const).filter((family) =>
    families.has(family),
  );
}

function executeCommand(
  executable: string,
  args: readonly string[],
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        timeout: 4_000,
        maxBuffer: 1_000_000,
        env: { ...process.env, PATH: resolvedCommandPath() },
      },
      (error, stdout) => {
        const exitCode =
          error && "code" in error && typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0;
        resolve({ exitCode, stdout });
      },
    );
  });
}
