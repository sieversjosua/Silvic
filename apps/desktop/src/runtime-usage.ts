import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlotRuntimeUsage } from "@silvic/contracts";
import type { SupervisedCommand } from "@silvic/core";

const executeFile = promisify(execFile);
type Execute = (executable: string, args: string[]) => Promise<string>;

/** One requested sample; no background polling or process signals. */
export async function sampleRuntimeUsage(
  commands: readonly SupervisedCommand[],
  options: { execute?: Execute; platform?: string; now?: number } = {},
): Promise<readonly PlotRuntimeUsage[]> {
  const execute: Execute =
    options.execute ??
    (async (executable, args) =>
      (
        await executeFile(executable, args, {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C" },
          timeout: 10_000,
          maxBuffer: 2_000_000,
        })
      ).stdout);
  const now = options.now ?? Date.now();
  const rows = (
    await execute("/bin/ps", ["-axo", "pid=,pgid=,rss=,%cpu=,etime="])
  )
    .split(/\r?\n/)
    .flatMap((line) => {
      const [pid, group, rss, cpu, elapsed] = line.trim().split(/\s+/);
      const uptime = elapsedSeconds(elapsed ?? "");
      return Number(pid) > 0 &&
        Number(group) > 0 &&
        Number.isFinite(Number(rss)) &&
        Number.isFinite(Number(cpu)) &&
        uptime !== undefined
        ? [
            {
              pid: Number(pid),
              group: Number(group),
              rss: Number(rss) * 1024,
              cpu: Number(cpu),
              uptime,
            },
          ]
        : [];
    });
  const selections = commands
    .filter((command) =>
      ["starting", "running", "stopping"].includes(command.status),
    )
    .map((command) => {
      const external = command.ownership === "external";
      const pid = external ? command.externalProcessId : command.processId;
      const leader = rows.find((row) => row.pid === pid);
      const started = Date.parse(command.startedAt ?? "");
      const verified =
        leader &&
        (external ||
          (leader.group === pid &&
            Number.isFinite(started) &&
            Math.abs((now - started) / 1000 - leader.uptime) < 5));
      return {
        command,
        leader: verified ? leader : undefined,
        members: verified
          ? rows.filter((row) =>
              external ? row.pid === pid : row.group === pid,
            )
          : [],
      };
    });
  const pids = [
    ...new Set(
      selections.flatMap((selection) =>
        selection.members.map((row) => row.pid),
      ),
    ),
  ];
  const memory = new Map<number, { footprint: number; compressed: number }>();
  if (
    (options.platform ?? process.platform) === "darwin" &&
    pids.length > 0 &&
    pids.length <= 256
  ) {
    try {
      const output = await execute("/usr/bin/top", [
        "-l",
        "1",
        "-n",
        String(pids.length),
        ...pids.flatMap((pid) => ["-pid", String(pid)]),
        "-stats",
        "pid,mem,cmprs",
      ]);
      for (const line of output.split(/\r?\n/)) {
        const [pid, mem, cmprs] = line.trim().split(/\s+/);
        const footprint = memoryBytes(mem ?? "");
        const compressed = memoryBytes(cmprs ?? "");
        if (
          pids.includes(Number(pid)) &&
          footprint !== undefined &&
          compressed !== undefined
        )
          memory.set(Number(pid), { footprint, compressed });
      }
    } catch {
      /* Resident memory remains available when macOS denies footprint sampling. */
    }
  }
  return selections.map(({ command, leader, members }) => {
    const measured =
      members.length > 0 && members.every((row) => memory.has(row.pid));
    return {
      id: command.id,
      ownership: command.ownership ?? "owned",
      sampledAt: new Date(now).toISOString(),
      processCount: members.length,
      residentBytes: members.reduce((sum, row) => sum + row.rss, 0),
      cpuPercent: members.reduce((sum, row) => sum + row.cpu, 0),
      ...(leader ? { uptimeSeconds: leader.uptime } : {}),
      ...(measured
        ? {
            footprintBytes: members.reduce(
              (sum, row) => sum + (memory.get(row.pid)?.footprint ?? 0),
              0,
            ),
            compressedBytes: members.reduce(
              (sum, row) => sum + (memory.get(row.pid)?.compressed ?? 0),
              0,
            ),
          }
        : {}),
      ...(!leader
        ? {
            detail:
              "The recorded process is gone or its identity could not be verified.",
          }
        : !measured
          ? {
              detail:
                "Physical footprint and compressed memory are unavailable; resident memory is shown.",
            }
          : {}),
    };
  });
}

function elapsedSeconds(value: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);
  return match
    ? Number(match[1] ?? 0) * 86400 +
        Number(match[2] ?? 0) * 3600 +
        Number(match[3]) * 60 +
        Number(match[4])
    : undefined;
}

function memoryBytes(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([BKMGTP])(?:[+-])?$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * 1024 ** "BKMGTP".indexOf(match[2] ?? "B");
}
