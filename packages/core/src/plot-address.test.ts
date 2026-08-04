import { describe, expect, it } from "vitest";

import { resolvePlotAddress, routeNameFor, routes } from "./plot-address";

describe("routes", () => {
  it("publishes serving commands by default and allows an explicit opt-out", () => {
    expect(routes({ run: "npm run dev", url: true })).toBe(true);
    expect(routes({ run: "npm run dev", url: true, portless: true })).toBe(
      true,
    );
    expect(routes({ run: "npm run test:watch" })).toBe(false);
    expect(routes({ run: "npm run dev", url: true, portless: false })).toBe(
      false,
    );
  });
});

describe("resolvePlotAddress", () => {
  it("gives the plot its wildcard-compatible named HTTPS address", () => {
    expect(
      resolvePlotAddress({
        commands: { web: { run: "bun dev", url: true } },
        plot: "auth-callback",
        project: "like-photo",
        port: 5788,
      }),
    ).toEqual({
      url: "https://web-auth-callback-like-photo.localhost",
      named: true,
    });
  });

  it("keeps the stable port URL when named routing is explicitly disabled", () => {
    expect(
      resolvePlotAddress({
        commands: {
          web: { run: "bun dev", url: true, portless: false },
        },
        plot: "auth-callback",
        project: "like-photo",
        port: 5788,
      }),
    ).toEqual({ url: "http://localhost:5788", named: false });
  });
});

describe("routeNameFor", () => {
  it("names a command the way work-cli does", () => {
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

  it("shortens only the plot so a project-specific wildcard still matches", () => {
    const name = routeNameFor(
      { id: "web" },
      "feature/this-is-a-very-long-branch-name-for-an-authentication-redesign",
      "like-photo",
    );

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^web-[a-z0-9-]+-like-photo$/);
  });

  it("keeps even extreme configured segments inside the DNS limit", () => {
    const name = routeNameFor(
      { id: "a-very-long-serving-command-name-that-could-be-configured" },
      "a-very-long-plot-name-that-could-also-come-from-a-feature-branch",
      "a-very-long-project-name-that-still-needs-a-stable-wildcard-suffix",
    );

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});
