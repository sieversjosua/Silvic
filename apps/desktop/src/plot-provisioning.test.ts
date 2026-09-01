import { describe, expect, it } from "vitest";

import type {
  ConvexServiceAttachment,
  PlotProvisioning,
  ProvisionResult,
} from "@silvic/contracts";

import { provisioningRecord, withServiceAttachment } from "./plot-provisioning";

const attachment: ConvexServiceAttachment = {
  provider: "convex",
  team: "syntwin",
  project: "mono",
  deploymentKind: "dev",
  recipeDeploymentName: "dev/owner-onboarding",
  logicalDeploymentRef: "syntwin:mono:dev/owner-onboarding",
  physicalDeploymentSlug: "fleet-alligator-19",
  expiration: "in 7 days",
};

const failed: PlotProvisioning = {
  status: "failed",
  at: "2026-09-01T08:00:00.000Z",
  steps: [
    {
      label: "Convex deployment",
      command: "Silvic isolated Convex environment",
      exitCode: 1,
      output: "Invalid Convex deploy key",
      durationMs: 1,
    },
  ],
};

describe("Plot provisioning attachments", () => {
  it("persists logical and physical Convex identity outside step output", () => {
    const step: ProvisionResult = {
      label: "Convex deployment",
      command: "Silvic isolated Convex environment",
      exitCode: 0,
      output: "provider output",
      durationMs: 1,
      attachment,
    };

    const record = provisioningRecord(
      undefined,
      [step],
      "2026-09-01T09:00:00.000Z",
      4_000,
    );

    expect(record.attachments).toEqual([attachment]);
    expect(record.steps[0]).not.toHaveProperty("attachment");
  });

  it("adds an explicit legacy adoption without erasing the failed recovery", () => {
    const adopted = withServiceAttachment(failed, attachment);

    expect(adopted).toMatchObject({
      status: "failed",
      steps: failed.steps,
      attachments: [attachment],
    });
  });

  it("replaces the old physical identity after successful recreation", () => {
    const recreated = {
      ...attachment,
      logicalDeploymentRef: "syntwin:mono:dev/owner-onboarding-recovery-new",
      physicalDeploymentSlug: "helpful-mouse-694",
    };
    const step: ProvisionResult = {
      label: "Convex deployment",
      command: "Silvic isolated Convex environment",
      exitCode: 0,
      output: "recreated",
      durationMs: 1,
      attachment: recreated,
    };

    const record = provisioningRecord(
      withServiceAttachment(failed, attachment),
      [step],
      "2026-09-01T09:00:00.000Z",
      4_000,
    );

    expect(record.attachments).toEqual([recreated]);
  });
});
