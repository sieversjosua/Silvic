import { describe, expect, it } from "vitest";

import { routeNameFor, routes } from "./command-supervisor";

describe("routes", () => {
  it("publishes a command that serves the plot's address", () => {
    expect(routes({ run: "npm run dev", url: true })).toBe(true);
  });

  it("leaves everything else where it is", () => {
    expect(routes({ run: "npm run test:watch" })).toBe(false);
    // Serving, but the project asked for the port it was given instead.
    expect(routes({ run: "npm run dev", url: true, portless: false })).toBe(
      false,
    );
  });
});

describe("routeNameFor", () => {
  it("names a command the way work already does on this machine", () => {
    expect(routeNameFor({ id: "web" }, "feature-x", "tilly")).toBe(
      "web-feature-x-tilly",
    );
  });

  it("takes the recipe's own segment when it gives one", () => {
    expect(
      routeNameFor({ id: "web", routeName: "app" }, "feature-x", "tilly"),
    ).toBe("app-feature-x-tilly");
  });

  it("keeps a single label, since a wildcard certificate covers one level", () => {
    const name = routeNameFor({ id: "web" }, "feat/Slashed", "My Project");

    expect(name).toBe("web-feat-slashed-my-project");
    expect(name).not.toContain(".");
  });
});
