import {
  mkdtemp,
  mkdir,
  writeFile,
  utimes,
  symlink,
  unlink,
  rm,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { RuntimeArtifacts } from "./runtime-artifacts";

it("cleans only the confirmed old generated artifacts and preserves sleeping routes and links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "silvic-artifacts-"));
  const certs = join(directory, "certs");
  const logs = join(directory, "logs");
  await mkdir(certs);
  await mkdir(logs);
  const old = new Date("2026-01-01");
  const now = Date.parse("2026-10-13");
  const files = [
    join(certs, "gone.localhost.key"),
    join(certs, "sleeping.localhost.pem"),
    join(certs, "ca.pem"),

    join(logs, "-tmp-gone::web.log"),
    join(logs, "-tmp-active::web.log"),
    join(logs, "unrelated.log"),
  ];
  try {
    for (const file of files) {
      await writeFile(file, "data");
      await utimes(file, old, old);
    }
    const gateCertificate = join(certs, "silvic-gate.localhost.pem");
    await writeFile(gateCertificate, "gate");
    await utimes(gateCertificate, old, old);
    await symlink(join(certs, "ca.pem"), join(certs, "link.localhost.pem"));
    const removeCertificate = async (file: { name: string }) =>
      unlink(join(certs, file.name));
    const removeRoute = vi.fn(async () => undefined);
    let protectedLogs = new Set(["-tmp-active::web.log"]);
    const cleanup = new RuntimeArtifacts({
      gateDirectory: directory,
      logDirectory: logs,
      now: () => now,
      routes: async () => [
        { name: "gone", plotPath: "/tmp/gone", updatedAt: old.toISOString() },
        {
          name: "sleeping",
          plotPath: "/tmp/sleeping",
          updatedAt: old.toISOString(),
        },
      ],
      removablePlotPaths: async () => new Set(["/tmp/gone"]),
      protectedLogNames: () => protectedLogs,
      removeRoute,
      removeCertificate,
    });
    const plan = await cleanup.inspect();
    expect(plan.routes.map((r) => r.name)).toEqual(["gone"]);
    expect(plan.files.map((f) => f.path)).toEqual([files[0], files[3]]);
    protectedLogs = new Set(["-tmp-active::web.log", "-tmp-gone::web.log"]);
    await expect(cleanup.prune(plan.planId)).rejects.toThrow(
      "Artifacts changed",
    );
    expect(removeRoute).not.toHaveBeenCalled();
    protectedLogs = new Set(["-tmp-active::web.log"]);
    await cleanup.prune(plan.planId);
    await expect(access(join(certs, "gone.localhost.key"))).rejects.toThrow();
    await expect(access(join(logs, "-tmp-gone::web.log"))).rejects.toThrow();
    for (const file of [
      join(certs, "sleeping.localhost.pem"),
      join(certs, "ca.pem"),

      join(logs, "-tmp-active::web.log"),
      join(logs, "unrelated.log"),
      join(certs, "link.localhost.pem"),
    ])
      await access(file);
    await access(gateCertificate);
    expect(removeRoute).toHaveBeenCalledWith("gone", old.toISOString());
    const offline = new RuntimeArtifacts({
      gateDirectory: directory,
      logDirectory: logs,
      now: () => now,
      routes: async () => [
        {
          name: "sleeping",
          plotPath: "/tmp/sleeping",
          updatedAt: old.toISOString(),
        },
      ],
      removablePlotPaths: async () => new Set(),
      protectedLogNames: () => protectedLogs,
      removeRoute,
      removeCertificate,
    });
    expect((await offline.inspect()).routes).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
