import { describe, expect, it } from "vitest";

import { pullRequestReference } from "./pull-request";

describe("pullRequestReference", () => {
  it("reads a pasted pull request URL, repository and all", () => {
    expect(
      pullRequestReference("https://github.com/Example/Silvic/pull/123"),
    ).toEqual({ number: 123, projectId: "github.com/example/silvic" });
  });

  it("ignores whatever GitHub appended to the URL", () => {
    expect(
      pullRequestReference(
        "  https://github.com/example/silvic/pull/123/files#diff-abc  ",
      ),
    ).toEqual({ number: 123, projectId: "github.com/example/silvic" });
  });

  it("reads a URL somebody copied without its scheme", () => {
    expect(pullRequestReference("github.com/example/silvic/pull/7")).toEqual({
      number: 7,
      projectId: "github.com/example/silvic",
    });
  });

  it("reads the number on its own, hash or not", () => {
    expect(pullRequestReference("#123")).toEqual({ number: 123 });
    expect(pullRequestReference("123")).toEqual({ number: 123 });
  });

  it("reads the owner/repo#number shorthand", () => {
    expect(pullRequestReference("example/silvic#42")).toEqual({
      number: 42,
      projectId: "github.com/example/silvic",
    });
  });

  it("is not a pull request when it is branch text", () => {
    expect(pullRequestReference("")).toBeUndefined();
    expect(pullRequestReference("agent/auth")).toBeUndefined();
    expect(pullRequestReference("#auth")).toBeUndefined();
    expect(pullRequestReference("fix-123")).toBeUndefined();
    expect(
      pullRequestReference("https://github.com/example/silvic/issues/123"),
    ).toBeUndefined();
  });

  it("refuses numbers no pull request has", () => {
    expect(pullRequestReference("#0")).toBeUndefined();
    expect(pullRequestReference("#12345678")).toBeUndefined();
  });
});
