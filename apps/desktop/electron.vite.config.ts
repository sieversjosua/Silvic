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
          "@silvic/gate",
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
        input: {
          main: resolve(directory, "src/main.ts"),
          gate: resolve(directory, "src/gate.ts"),
        },
        output: {
          format: "es",
          // The gate runs under launchd as plain Node, outside the asar and
          // without a neighbouring package.json; .mjs keeps it and the
          // chunks it shares with main ESM there.
          entryFileNames: (chunk) =>
            chunk.name === "gate" ? "[name].mjs" : "[name].js",
          chunkFileNames: "chunks/[name]-[hash].mjs",
        },
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
