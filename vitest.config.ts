import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["{apps,packages,connectors}/**/*.test.ts"],
    // Live checks start real processes and want portless, curl and lsof. Run
    // them deliberately: `npx vitest run --mode live <file>`.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
