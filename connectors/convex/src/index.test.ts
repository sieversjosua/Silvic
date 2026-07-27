import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceTarget } from "@silvic/contracts";

import { convexConnector } from "./index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("convexConnector", () => {
  it("reports public deployment metadata without exposing secrets", async () => {
    const path = await mkdtemp(join(tmpdir(), "silvic-convex-"));
    temporaryDirectories.push(path);
    await writeFile(
      join(path, ".env.local"),
      [
        "CONVEX_DEPLOYMENT=dev:helpful-otter-123",
        "NEXT_PUBLIC_CONVEX_URL=https://helpful-otter-123.convex.cloud",
        "CONVEX_DEPLOY_KEY=secret-value",
      ].join("\n"),
    );
    const target: WorkspaceTarget = {
      workspaceId: "workspace-1",
      projectId: "project-1",
      path,
      repositoryName: "silvic",
      branch: "main",
    };

    const observations = await convexConnector.observe(target);

    expect(observations).toEqual([
      {
        connectorId: "convex",
        workspaceId: "workspace-1",
        kind: "deployment",
        state: "active",
        label: "helpful-otter-123",
        detail: "dev",
        url: "https://helpful-otter-123.convex.cloud",
        metadata: {
          source: ".env.local",
        },
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain("secret-value");
  });

  it("keeps the deployment name clean when the line carries a team comment", async () => {
    const path = await mkdtemp(join(tmpdir(), "silvic-convex-"));
    temporaryDirectories.push(path);
    // What `npx convex deployment create --select` actually writes.
    await writeFile(
      join(path, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:reliable-curlew-319 # team: josua-sievers, project: sievate-attributes\n",
    );
    const target: WorkspaceTarget = {
      workspaceId: "workspace-1",
      projectId: "project-1",
      path,
      repositoryName: "silvic",
      branch: "main",
    };

    const [observation] = await convexConnector.observe(target);

    expect(observation?.label).toBe("reliable-curlew-319");
    expect(observation?.detail).toBe("dev");
  });
});
