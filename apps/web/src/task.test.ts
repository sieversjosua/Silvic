import { describe, expect, it } from "vitest";

import { branchForIssue } from "./task";

describe("branchForIssue", () => {
  it("turns the selected Issue into a readable Git branch", () => {
    expect(
      branchForIssue({
        provider: "github",
        number: 184,
        title: "Fix HEIC uploads & conversion!",
        body: "",
        url: "https://github.com/example/app/issues/184",
        labels: [],
        assignees: [],
      }),
    ).toBe("issue/184-fix-heic-uploads-conversion");
  });
});
