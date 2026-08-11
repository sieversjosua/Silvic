import { execFile, spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface CommandRequest {
  executable: string;
  arguments?: readonly string[];
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
  input?: string;
  signal?: AbortSignal;
  /**
   * Called with each chunk of stdout and stderr as it arrives. The buffered
   * result is still returned in full; this only exists so a caller can show
   * a long-running command moving rather than a frozen interface.
   */
  onOutput?: (chunk: string) => void;
  /** Maximum buffered bytes per stdout/stderr stream. */
  outputLimit?: number;
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
      const stdout = new BoundedBuffer(request.outputLimit ?? 5_000_000);
      const stderr = new BoundedBuffer(request.outputLimit ?? 5_000_000);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.append(chunk);
        request.onOutput?.(chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.append(chunk);
        request.onOutput?.(chunk.toString("utf8"));
      });
      if (request.input !== undefined) child.stdin?.end(request.input);
      child.once("error", reject);
      child.once("close", (exitCode) => {
        resolve({
          exitCode: exitCode ?? -1,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      });
    });
  }
}

let cachedCommandPath: string | undefined;
let commandPathPrime: Promise<void> | undefined;

export function primeResolvedCommandPath(): Promise<void> {
  if (commandPathPrime) return commandPathPrime;
  const marker = "__SILVIC_PATH__";
  commandPathPrime = executeFile(
    "/bin/zsh",
    ["-ilc", `printf '\\n${marker}%s\\n' \"$PATH\"`],
    { encoding: "utf8", timeout: 5_000 },
  )
    .then(({ stdout }) => {
      const markerIndex = stdout.lastIndexOf(marker);
      const loginPath =
        markerIndex >= 0
          ? stdout.slice(markerIndex + marker.length).split(/\r?\n/, 1)[0]
          : undefined;
      cachedCommandPath = commandPath(loginPath ?? process.env.PATH);
    })
    .catch(() => {
      cachedCommandPath = commandPath(process.env.PATH);
    });
  return commandPathPrime;
}

export function resolvedCommandPath(): string {
  return cachedCommandPath ?? commandPath(process.env.PATH);
}

class BoundedBuffer {
  private readonly head: Buffer[] = [];
  private readonly tail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private totalBytes = 0;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    const headLimit = Math.floor(this.limit / 2);
    const remainingHead = Math.max(0, headLimit - this.headBytes);
    if (remainingHead > 0) {
      const first = chunk.subarray(0, remainingHead);
      this.head.push(first);
      this.headBytes += first.length;
      chunk = chunk.subarray(first.length);
    }
    if (chunk.length === 0) return;
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    const tailLimit = this.limit - headLimit;
    while (this.tailBytes > tailLimit && this.tail.length > 0) {
      const first = this.tail[0]!;
      const overflow = this.tailBytes - tailLimit;
      if (first.length <= overflow) {
        this.tail.shift();
        this.tailBytes -= first.length;
      } else {
        this.tail[0] = first.subarray(overflow);
        this.tailBytes -= overflow;
      }
    }
  }

  toString(): string {
    const marker =
      this.totalBytes > this.limit
        ? Buffer.from("\n… output truncated …\n", "utf8")
        : Buffer.alloc(0);
    return Buffer.concat([...this.head, marker, ...this.tail]).toString("utf8");
  }
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
