import { expect, it, vi } from "vitest";
import { sampleRuntimeUsage } from "./runtime-usage";

const command = {
  plotPath: "/tmp/demo",
  id: "web",
  status: "running",
  processId: 100,
  startedAt: "2026-10-13T10:00:00Z",
} as const;
const now = Date.parse("2026-10-13T10:01:00Z");

it("sums an owned group including children and keeps compressed separate from footprint", async () => {
  const execute = vi.fn(async (executable: string, _args: string[]) =>
    executable.endsWith("ps")
      ? "100 100 1024 1.5 01:00\n101 100 2048 20.0 00:30\n200 200 999999 99 05:00\n"
      : "PID MEM CMPRS\n100 20M 4M\n101 100M 25M\n200 9G 2G\n",
  );
  const samples = await sampleRuntimeUsage([command], {
    execute,
    platform: "darwin",
    now,
  });
  expect(samples[0]).toMatchObject({
    processCount: 2,
    residentBytes: 3072 * 1024,
    footprintBytes: 120 * 1024 ** 2,
    compressedBytes: 29 * 1024 ** 2,
    cpuPercent: 21.5,
    uptimeSeconds: 60,
    ownership: "owned",
  });
  expect(execute.mock.calls[1]?.[1]).toEqual([
    "-l",
    "1",
    "-n",
    "2",
    "-pid",
    "100",
    "-pid",
    "101",
    "-stats",
    "pid,mem,cmprs",
  ]);
});

it("rejects a reused leader PID and reads only the external process", async () => {
  const execute = vi.fn(
    async () =>
      "100 100 1024 1.5 00:01\n200 200 2048 2 1-02:03:04\n201 200 9999 99 00:30\n",
  );
  const samples = await sampleRuntimeUsage(
    [
      command,
      {
        ...command,
        id: "agent",
        ownership: "external",
        externalProcessId: 200,
      },
    ],
    { execute, platform: "linux", now },
  );
  expect(samples[0]).toMatchObject({
    processCount: 0,
    detail: expect.stringContaining("identity"),
  });
  expect(samples[1]).toMatchObject({
    ownership: "external",
    processCount: 1,
    residentBytes: 2048 * 1024,
    uptimeSeconds: 93784,
  });
  expect(samples[1]?.footprintBytes).toBeUndefined();
  expect(execute).toHaveBeenCalledOnce();
});

it("falls back explicitly when top fails or a child footprint is absent", async () => {
  for (const fail of [true, false]) {
    const execute = vi.fn(async (executable: string, _args: string[]) => {
      if (executable.endsWith("ps"))
        return "100 100 1000 1 01:00\n101 100 1000 1 00:30\n";
      if (fail) throw new Error("sampling denied");
      return "100 20M 0B\n";
    });
    const [sample] = await sampleRuntimeUsage([command], {
      execute,
      platform: "darwin",
      now,
    });
    expect(sample?.footprintBytes).toBeUndefined();
    expect(sample?.residentBytes).toBe(2000 * 1024);
    expect(sample?.detail).toContain("unavailable");
  }
});
