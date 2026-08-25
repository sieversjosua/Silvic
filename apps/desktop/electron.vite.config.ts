import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const directory = fileURLToPath(new URL(".", import.meta.url));
const { version } = JSON.parse(
  readFileSync(resolve(directory, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  main: {
    // The gate daemon reports this so the app can restart it after updates.
    define: { __SILVIC_GATE_VERSION__: JSON.stringify(version) },
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@silvic/automation",
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
