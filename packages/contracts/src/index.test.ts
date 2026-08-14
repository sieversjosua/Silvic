import { describe, expect, it } from "vitest";

import { plotRenameRequestSchema } from "./index";

describe("plotRenameRequestSchema", () => {
  it("trims and accepts a human Plot name", () => {
    expect(
      plotRenameRequestSchema.parse({
        workspaceId: "plot-184",
        name: "  Image upload repair  ",
      }),
    ).toEqual({ workspaceId: "plot-184", name: "Image upload repair" });
  });

  it("rejects an empty Plot name", () => {
    expect(() =>
      plotRenameRequestSchema.parse({
        workspaceId: "plot-184",
        name: "   ",
      }),
    ).toThrow();
  });
});
