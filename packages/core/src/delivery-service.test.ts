import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalCommandRunner, requireSuccess } from "./command-runner";
import { DeliveryService, sanitizeContext } from "./delivery-service";

describe("DeliveryService", () => {
  it("redacts common credential syntax before AI use", () => {
    const sanitized = sanitizeContext(`
{"token":"ghp_abcdefghijklmnopqrstuvwxyz123456"}
Authorization: Bearer abc.def.ghi
AWS_SECRET_ACCESS_KEY=secret-value
https://user:password@example.test/path
`);
    expect(sanitized).not.toContain("ghp_");
    expect(sanitized).not.toContain("abc.def.ghi");
    expect(sanitized).not.toContain("secret-value");
    expect(sanitized).not.toContain("user:password");
  });

  it("inspects and commits local changes after confirmation", async () => {
    const runner = new LocalCommandRunner();
    const repository = await mkdtemp(join(tmpdir(), "silvic-delivery-"));
    await requireSuccess(runner, {
      executable: "git",
      arguments: ["init", "--initial-branch=main"],
      cwd: repository,
    });
    await requireSuccess(runner, {
      executable: "git",
      arguments: ["config", "user.email", "silvic@example.test"],
      cwd: repository,
    });
    await requireSuccess(runner, {
      executable: "git",
      arguments: ["config", "user.name", "Silvic Test"],
      cwd: repository,
    });
    await writeFile(join(repository, "README.md"), "new\n");
    const outsideSecret = join(repository, "..", "outside-secret.txt");
    await writeFile(outsideSecret, "do-not-preview\n");
    await symlink(outsideSecret, join(repository, "linked-secret.txt"));

    const service = new DeliveryService(runner);
    const changes = await service.changes(repository);
    expect(changes.status).toContain("README.md");
    expect(changes.patch).not.toContain("do-not-preview");
    expect(changes.warnings).toHaveLength(1);

    await service.execute({
      path: repository,
      commitMessage: "Add readme",
      push: false,
      createPullRequest: false,
      pullRequestTitle: "",
      pullRequestBody: "",
      reviewDigest: changes.reviewDigest,
      confirmed: true,
    });

    expect(
      (
        await requireSuccess(runner, {
          executable: "git",
          arguments: ["log", "-1", "--pretty=%s"],
          cwd: repository,
        })
      ).trim(),
    ).toBe("Add readme");
  });
});
