import { defineConfig } from "vitest/config";

// Live checks start real processes and want portless, curl and lsof, so they
// run only when asked for by mode: `npx vitest run --mode live [file]`.
export default defineConfig(({ mode }) => ({
  test: {
    environment: "node",
    include:
      mode === "live"
        ? ["{apps,packages,connectors}/**/*.live.test.ts"]
        : ["{apps,packages,connectors}/**/*.test.ts"],
    exclude:
      mode === "live"
        ? ["**/node_modules/**"]
        : ["**/node_modules/**", "**/*.live.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
}));
