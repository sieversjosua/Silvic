import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const directory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@silvic/contracts",
          "@silvic/core",
          "@silvic/connector-convex",
          "@silvic/connector-github",
          "@silvic/connector-harnesses",
          "@silvic/connector-local",
        ],
      }),
    ],
    build: {
      rollupOptions: {
        external: ["electron"],
        input: resolve(directory, "src/main.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@silvic/contracts"] })],
    build: {
      rollupOptions: {
        external: ["electron"],
        input: resolve(directory, "src/preload.ts"),
        output: {
          format: "cjs",
          entryFileNames: "preload.cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve(directory, "../web"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(directory, "../web/index.html"),
      },
    },
  },
});
