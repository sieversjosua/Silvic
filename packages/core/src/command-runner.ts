import { spawn, spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

export interface CommandRequest {
  executable: string;
  arguments?: readonly string[];
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
  input?: string;
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export class LocalCommandRunner implements CommandRunner {
  run(request: CommandRequest): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, request.arguments ?? [], {
        cwd: request.cwd,
        env: {
          ...process.env,
          PATH: resolvedCommandPath(),
          ...request.environment,
        },
        signal: request.signal,
        stdio: [
          request.input === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
        ],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      if (request.input !== undefined) child.stdin?.end(request.input);
      child.once("error", reject);
      child.once("close", (exitCode) => {
        resolve({
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  }
}

let cachedCommandPath: string | undefined;

export function resolvedCommandPath(): string {
  if (cachedCommandPath) return cachedCommandPath;
  const marker = "__SILVIC_PATH__";
  const shell = spawnSync(
    "/bin/zsh",
    ["-ilc", `printf '\\n${marker}%s\\n' \"$PATH\"`],
    {
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  const markerIndex = shell.stdout?.lastIndexOf(marker) ?? -1;
  const loginPath =
    markerIndex >= 0
      ? shell.stdout.slice(markerIndex + marker.length).split(/\r?\n/, 1)[0]
      : undefined;
  cachedCommandPath = commandPath(loginPath ?? process.env.PATH);
  return cachedCommandPath;
}

function commandPath(existing: string | undefined): string {
  return [
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".volta", "bin"),
    join(homedir(), ".asdf", "shims"),
    join(homedir(), ".local", "share", "mise", "shims"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    ...(existing?.split(delimiter) ?? []),
  ]
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .join(delimiter);
}

export async function requireSuccess(
  runner: CommandRunner,
  request: CommandRequest,
): Promise<string> {
  const result = await runner.run(request);
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(`${request.executable} failed: ${detail}`);
  }
  return result.stdout;
}
