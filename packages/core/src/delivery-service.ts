import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";

import type {
  DeliveryDraft,
  DeliveryExecuteRequest,
  DeliveryResult,
  WorkspaceChanges,
} from "@silvic/contracts";

import type { CommandRunner } from "./command-runner";
import { requireSuccess } from "./command-runner";

const maximumPatchLength = 60_000;

export class DeliveryService {
  constructor(private readonly runner: CommandRunner) {}

  async changes(path: string): Promise<WorkspaceChanges> {
    const [
      status,
      stagedSummary,
      unstagedSummary,
      staged,
      unstaged,
      untracked,
    ] = await Promise.all([
      this.git(path, ["status", "--short"]),
      this.git(path, ["diff", "--cached", "--stat"]),
      this.git(path, ["diff", "--stat"]),
      this.git(path, ["diff", "--cached", "--no-ext-diff", "--unified=3"]),
      this.git(path, ["diff", "--no-ext-diff", "--unified=3"]),
      this.untrackedPreviews(path),
    ]);
    const summary = [stagedSummary, unstagedSummary].filter(Boolean).join("\n");
    const patch = [
      `STATUS\n${status}`,
      `SUMMARY\n${summary}`,
      `STAGED\n${staged}`,
      `UNSTAGED\n${unstaged}`,
      `UNTRACKED PREVIEWS\n${untracked.contents}`,
    ].join("\n\n");
    const warnings: string[] = [];
    if (patch.length > maximumPatchLength) {
      warnings.push("The displayed patch is truncated at 60 KB.");
    }
    if (untracked.omitted > 0) {
      warnings.push(
        `${untracked.omitted} untracked file${untracked.omitted === 1 ? " was" : "s were"} omitted from the preview.`,
      );
    }
    return {
      status,
      summary,
      patch: patch.slice(0, maximumPatchLength),
      truncated: patch.length > maximumPatchLength,
      reviewDigest: await this.reviewDigest(path),
      warnings,
    };
  }

  async draft(path: string): Promise<DeliveryDraft> {
    const changes = await this.changes(path);
    if (!changes.status.trim())
      throw new Error("There are no local changes to draft");
    const prompt = [
      "Draft delivery text for these Git changes.",
      "Return JSON only with string fields commitMessage, pullRequestTitle, pullRequestBody.",
      "Use an imperative commit subject under 72 characters. Keep the PR body concise.",
      sanitizeContext(changes.patch),
    ].join("\n\n");
    const result = await this.runner.run({
      executable: "codex",
      arguments: [
        "exec",
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--skip-git-repo-check",
        "-",
      ],
      cwd: path,
      input: prompt,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || "Codex could not draft delivery text",
      );
    }
    return parseDraft(result.stdout);
  }

  async execute(request: DeliveryExecuteRequest): Promise<DeliveryResult> {
    if (!request.confirmed)
      throw new Error("Delivery must be explicitly confirmed");
    const before = await this.reviewDigest(request.path);
    if (before !== request.reviewDigest) {
      throw new Error(
        "Workspace changed after review. Review the latest changes before committing.",
      );
    }
    const status = await this.git(request.path, ["status", "--short"]);
    if (status.trim()) {
      await this.git(request.path, ["add", "-A"]);
      const afterStaging = await this.reviewDigest(request.path);
      if (afterStaging !== request.reviewDigest) {
        throw new Error(
          "Workspace changed while staging. Review the latest changes before committing.",
        );
      }
      await this.git(request.path, ["commit", "-m", request.commitMessage]);
    }
    if (request.push) {
      const branch = (
        await this.git(request.path, ["branch", "--show-current"])
      ).trim();
      if (!branch) throw new Error("Cannot push a detached Workspace");
      await this.git(request.path, ["push", "-u", "origin", branch]);
    }
    if (!request.createPullRequest) return {};
    const output = await requireSuccess(this.runner, {
      executable: "gh",
      arguments: [
        "pr",
        "create",
        "--title",
        request.pullRequestTitle || request.commitMessage,
        "--body",
        request.pullRequestBody,
      ],
      cwd: request.path,
    });
    const pullRequestUrl = output
      .split(/\s+/)
      .find((value) => /^https:\/\/github\.com\//.test(value));
    return pullRequestUrl ? { pullRequestUrl } : {};
  }

  private git(path: string, arguments_: readonly string[]): Promise<string> {
    return requireSuccess(this.runner, {
      executable: "git",
      arguments: arguments_,
      cwd: path,
      environment: { GIT_OPTIONAL_LOCKS: "0" },
    });
  }

  private async untrackedPreviews(
    path: string,
  ): Promise<{ contents: string; omitted: number }> {
    const output = await this.git(path, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const allowed = new Set([
      ".css",
      ".html",
      ".js",
      ".json",
      ".jsx",
      ".md",
      ".mjs",
      ".sh",
      ".swift",
      ".toml",
      ".ts",
      ".tsx",
      ".txt",
      ".yaml",
      ".yml",
    ]);
    const previews: string[] = [];
    let remaining = 20_000;
    let omitted = 0;
    const files = output.split("\0").filter(Boolean);
    for (const [index, file] of files.entries()) {
      if (index >= 20) {
        omitted += 1;
        continue;
      }
      const absolutePath = join(path, file);
      const relation = relative(path, absolutePath);
      if (
        relation.startsWith("..") ||
        isAbsolute(relation) ||
        !allowed.has(extname(file).toLowerCase())
      ) {
        omitted += 1;
        continue;
      }
      try {
        const information = await lstat(absolutePath);
        if (
          !information.isFile() ||
          information.isSymbolicLink() ||
          information.size > 50_000
        ) {
          omitted += 1;
          continue;
        }
        const fullContents = await readFile(absolutePath, "utf8");
        const contents = fullContents.slice(0, remaining);
        previews.push(`--- ${file}\n${contents}`);
        remaining -= contents.length;
        if (remaining <= 0) {
          if (contents.length < fullContents.length) omitted += 1;
          omitted += files.length - index - 1;
          break;
        }
      } catch {
        // A concurrently removed file does not invalidate the rest of the review.
        omitted += 1;
      }
    }
    return { contents: previews.join("\n\n"), omitted };
  }

  private async reviewDigest(path: string): Promise<string> {
    const [status, revision] = await Promise.all([
      this.git(path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
      this.runner.run({
        executable: "git",
        arguments: ["rev-parse", "--verify", "HEAD"],
        cwd: path,
      }),
    ]);
    const hash = createHash("sha256");
    hash.update(revision.exitCode === 0 ? revision.stdout.trim() : "(unborn)");
    for (const file of changedPaths(status)) {
      hash.update(`\0${file}\0`);
      const absolutePath = join(path, file);
      const relation = relative(path, absolutePath);
      if (relation.startsWith("..") || isAbsolute(relation)) {
        hash.update("[outside]");
        continue;
      }
      try {
        const information = await lstat(absolutePath);
        hash.update(`${information.mode}:${information.size}:`);
        if (information.isSymbolicLink()) {
          hash.update(await readlink(absolutePath));
        } else if (information.isFile()) {
          for await (const chunk of createReadStream(absolutePath)) {
            hash.update(chunk);
          }
        }
      } catch {
        hash.update("[missing]");
      }
    }
    return hash.digest("hex");
  }
}

function changedPaths(status: string): string[] {
  return [
    ...new Set(
      status
        .split("\0")
        .filter(Boolean)
        .map((token) =>
          /^[ MADRCU?!]{2} /.test(token) ? token.slice(3) : token,
        ),
    ),
  ].sort();
}

export function sanitizeContext(value: string): string {
  const withoutPrivateKeys = value.replace(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  );
  return withoutPrivateKeys
    .split(/\r?\n/)
    .map((line) =>
      /(?:api[_-]?key|token|password|secret|deploy[_-]?key|authorization|aws_access_key_id|aws_secret_access_key)/i.test(
        line,
      )
        ? "[REDACTED SECRET ASSIGNMENT]"
        : line,
    )
    .join("\n")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED AWS KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[REDACTED JWT]",
    )
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://[REDACTED CREDENTIALS]@");
}

function parseDraft(output: string): DeliveryDraft {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error("Codex returned an unreadable draft");
  const value: unknown = JSON.parse(output.slice(start, end + 1));
  if (
    typeof value !== "object" ||
    value === null ||
    !("commitMessage" in value) ||
    !("pullRequestTitle" in value) ||
    !("pullRequestBody" in value) ||
    typeof value.commitMessage !== "string" ||
    typeof value.pullRequestTitle !== "string" ||
    typeof value.pullRequestBody !== "string"
  ) {
    throw new Error("Codex returned an unreadable draft");
  }
  return {
    commitMessage: value.commitMessage.trim(),
    pullRequestTitle: value.pullRequestTitle.trim(),
    pullRequestBody: value.pullRequestBody.trim(),
  };
}
