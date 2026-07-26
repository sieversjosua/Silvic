import { describe, expect, it } from "vitest";

import { concernsBranch, failureMessage } from "./errors";

describe("failureMessage", () => {
  it("drops the channel Electron wrapped the failure in", () => {
    const raw = new Error(
      "Error invoking remote method 'silvic:environment:create': Error: Branch fest/test already exists",
    );

    expect(failureMessage(raw)).toBe("Branch fest/test already exists");
  });

  it("leaves a sentence Silvic wrote alone", () => {
    expect(failureMessage(new Error("Choose a discovered Workspace"))).toBe(
      "Choose a discovered Workspace",
    );
  });

  it("strips the error class from anything thrown without the wrapper", () => {
    expect(failureMessage("TypeError: path is not a string")).toBe(
      "path is not a string",
    );
  });

  it("says something rather than nothing when the failure was silent", () => {
    expect(failureMessage(new Error(""))).toMatch(/went wrong/i);
  });
});

describe("concernsBranch", () => {
  it("recognises the refusals the branch field can answer for", () => {
    expect(concernsBranch("Branch fest/test already exists")).toBe(true);
    expect(concernsBranch("Enter a valid Git branch name")).toBe(true);
    expect(concernsBranch("That branch name has no usable plot name")).toBe(
      true,
    );
  });

  it("leaves everything else to the dialog", () => {
    expect(concernsBranch("The destination already exists")).toBe(false);
    expect(concernsBranch("Choose a discovered Workspace")).toBe(false);
  });
});
