import type {
  PlotProvisioning,
  ProvisionResult,
  ServiceAttachment,
} from "@silvic/contracts";

export function provisioningRecord(
  current: PlotProvisioning | undefined,
  steps: readonly ProvisionResult[],
  at: string,
  outputLimit: number,
): PlotProvisioning {
  const established = steps.flatMap((step) =>
    step.attachment ? [step.attachment] : [],
  );
  const attachments = mergeServiceAttachments(
    current?.attachments ?? [],
    established,
  );
  return {
    status: steps.some((step) => step.exitCode !== 0) ? "failed" : "complete",
    at,
    steps: steps.map(({ attachment: _attachment, ...step }) => ({
      ...step,
      output: step.output.slice(0, outputLimit),
    })),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function withServiceAttachment(
  current: PlotProvisioning,
  attachment: ServiceAttachment,
): PlotProvisioning {
  return {
    ...current,
    attachments: mergeServiceAttachments(current.attachments ?? [], [
      attachment,
    ]),
  };
}

function mergeServiceAttachments(
  current: readonly ServiceAttachment[],
  established: readonly ServiceAttachment[],
): ServiceAttachment[] {
  const byProvider = new Map(
    current.map((attachment) => [attachment.provider, attachment]),
  );
  for (const attachment of established) {
    byProvider.set(attachment.provider, attachment);
  }
  return [...byProvider.values()];
}
