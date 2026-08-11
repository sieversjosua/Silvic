import { describe, expect, it } from "vitest";

import { LocalCommandRunner } from "./command-runner";

describe("LocalCommandRunner", () => {
  it("bounds buffered command output while retaining its beginning and end", async () => {
    const result = await new LocalCommandRunner().run({
      executable: process.execPath,
      arguments: [
        "-e",
        "process.stdout.write('BEGIN' + 'x'.repeat(200) + 'END')",
      ],
      outputLimit: 40,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("BEGIN");
    expect(result.stdout).toContain("output truncated");
    expect(result.stdout).toContain("END");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(80);
  });
});
