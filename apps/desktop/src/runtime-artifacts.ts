import { createHash } from "node:crypto";
import { lstat, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import type { RuntimeArtifactPlan } from "@silvic/contracts";
import { GATE_HOST, type GateRoute } from "@silvic/gate";

export interface RuntimeArtifactOptions {
  gateDirectory: string;
  logDirectory: string;
  routes(): Promise<readonly GateRoute[] | undefined>;
  removablePlotPaths(): Promise<ReadonlySet<string>>;
  protectedLogNames(): ReadonlySet<string>;
  removeRoute(name: string, updatedAt: string): Promise<void>;
  removeCertificate(file: {
    name: string;
    bytes: number;
    modifiedAt: number;
    inode: number;
  }): Promise<void>;
  now?(): number;
}

/** Separate from registry pruning: only generated Silvic routes and files. */
export class RuntimeArtifacts {
  constructor(private readonly options: RuntimeArtifactOptions) {}

  async inspect(): Promise<RuntimeArtifactPlan> {
    const routes = await this.options.routes();
    if (!routes)
      throw new Error("The gate must be available to inspect artifacts.");
    const removable = await this.options.removablePlotPaths();
    const cutoff = (this.options.now?.() ?? Date.now()) - 30 * 86_400_000;
    const routeTargets = routes.filter(
      (route) =>
        route.plotPath &&
        removable.has(route.plotPath) &&
        route.port === undefined &&
        Date.parse(route.updatedAt) < cutoff,
    );
    const retained = new Set(
      routes
        .filter((route) => !routeTargets.includes(route))
        .map((route) => `${route.name}.localhost`),
    );
    retained.add(GATE_HOST);
    const protectedLogs = this.options.protectedLogNames();
    const files: RuntimeArtifactPlan["files"][number][] = [];
    for (const [directory, kind] of [
      [join(this.options.gateDirectory, "certs"), "certificate"],
      [this.options.logDirectory, "log"],
    ] as const) {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        throw error;
      }
      for (const name of names) {
        const certificate = /^([a-z0-9][a-z0-9-]*\.localhost)\.(pem|key)$/.exec(
          name,
        );
        if (
          kind === "certificate"
            ? !certificate || retained.has(certificate[1] ?? "")
            : !/^-.+::[a-zA-Z0-9_-]+\.log(?:\.1)?$/.test(name) ||
              protectedLogs.has(name)
        )
          continue;
        const path = join(directory, name);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        files.push({
          path,
          kind,
          bytes: stat.size,
          modifiedAt: stat.mtimeMs,
          inode: stat.ino,
        });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const targets = routeTargets
      .map((route) => ({ name: route.name, updatedAt: route.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const planId = `artifacts_${createHash("sha256").update(JSON.stringify({ targets, files })).digest("hex").slice(0, 16)}`;
    return { planId, retentionDays: 30, routes: targets, files };
  }

  async prune(confirmPlanId: string): Promise<RuntimeArtifactPlan> {
    const plan = await this.inspect();
    if (plan.planId !== confirmPlanId)
      throw new Error(`Artifacts changed. Inspect and confirm ${plan.planId}.`);
    // Remove routes through the daemon, which owns its in-memory registry.
    for (const route of plan.routes)
      await this.options.removeRoute(route.name, route.updatedAt);
    for (const file of plan.files) {
      if (file.kind === "certificate") {
        await this.options.removeCertificate({
          name: basename(file.path),
          bytes: file.bytes,
          modifiedAt: file.modifiedAt,
          inode: file.inode,
        });
        continue;
      }
      const stat = await lstat(file.path);
      if (
        !stat.isFile() ||
        stat.ino !== file.inode ||
        stat.mtimeMs !== file.modifiedAt ||
        stat.size !== file.bytes
      )
        throw new Error(
          "An artifact changed during cleanup. Inspect a fresh plan.",
        );
      await unlink(file.path);
    }
    return plan;
  }
}
