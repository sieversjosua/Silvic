import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["{apps,packages,connectors}/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
