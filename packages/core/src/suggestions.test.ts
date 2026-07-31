import { describe, expect, it } from "vitest";

import { suggestedCommands, suggestedSteps } from "./detect";

const npmConvex = {
  packageManager: "npm" as const,
  devScript: "dev",
  convex: true,
  workConfig: false,
  envExample: ".env.example",
  scripts: {
    dev: "next dev",
    codegen: "graphql-codegen",
    "test:watch": "vitest",
  },
};

describe("what Silvic offers for a repository", () => {
  it("proposes steps in the repository's own words", () => {
    const steps = suggestedSteps(npmConvex);
    const byId = new Map(steps.map((entry) => [entry.id, entry]));

    expect(byId.get("install")?.detail).toBe("npm install");
    expect(byId.get("convex")?.step).toEqual({
      convex: { name: "dev/{plot}" },
    });
    // A script the repository actually has, given back as a sentence.
    expect(byId.get("script:codegen")?.label).toBe("Codegen");
    expect(byId.get("script:codegen")?.detail).toBe("graphql-codegen");
  });

  it("proposes the dev server as the command that serves the address", () => {
    const [web] = suggestedCommands(npmConvex);

    expect(web?.command?.id).toBe("web");
    expect(web?.command?.command).toEqual({
      run: "npm run dev",
      url: true,
      autoStart: true,
    });
  });

  it("keeps the isolated Convex deployment in sync after setup", () => {
    const convex = suggestedCommands(npmConvex).find(
      (suggestion) => suggestion.command?.id === "convex",
    );

    expect(convex?.command?.command).toEqual({
      run: "npx convex dev",
      autoStart: true,
    });
  });

  it("offers nothing it has not seen", () => {
    const bare = { convex: false, workConfig: false };

    expect(suggestedSteps(bare)).toEqual([]);
    expect(suggestedCommands(bare)).toEqual([]);
  });
});
