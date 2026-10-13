import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { openRuntimeLog, readLogTail, readLogTailSync } from "./runtime-log";

describe("runtime logs", () => {
  it("reads the Unicode suffix of a large sparse log without loading the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "silvic-log-"));
    const path = join(directory, "runtime.log");
    try {
      const file = await open(path, "w");
      const suffix = "finished: Grüße 🌲\n";
      await file.write(suffix, 400 * 1024 * 1024);
      await file.close();
      expect(await readLogTail(path, suffix.length)).toBe(suffix);
      expect(readLogTailSync(path, suffix.length)).toBe(suffix);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rotates without replacing the inherited append-only descriptor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "silvic-log-"));
    const path = join(directory, "runtime.log");
    const errors = vi.fn();
    const log = await openRuntimeLog(path, false, errors, 1024);
    try {
      const inode = (await stat(path)).ino;
      writeSync(log.fd, "x".repeat(2048));
      await vi.waitFor(async () => expect((await stat(path)).size).toBe(0), {
        timeout: 3000,
      });
      expect((await stat(path)).ino).toBe(inode);
      expect((await stat(`${path}.1`)).size).toBe(1024);
      writeSync(log.fd, "still running\n");
      expect(await readFile(path, "utf8")).toBe("still running\n");
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await log.end();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds existing logs on append and preserves recovery output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "silvic-log-"));
    const path = join(directory, "runtime.log");
    await writeFile(path, "old".repeat(1024));
    const log = await openRuntimeLog(path, true, () => undefined, 1024);
    try {
      expect((await stat(`${path}.1`)).size).toBe(1024);
      log.write("recovered\n");
      await vi.waitFor(async () =>
        expect(await readLogTail(path)).toContain("recovered"),
      );
    } finally {
      await log.end();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes after a backup-write failure and allows reopening the same log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "silvic-log-"));
    const path = join(directory, "runtime.log");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(`${path}.1`);
    const errors = vi.fn();
    const log = await openRuntimeLog(path, false, errors, 1024);
    try {
      writeSync(log.fd, "x".repeat(2048));
      await log.end();
      expect(errors).toHaveBeenCalled();
      await rm(`${path}.1`, { recursive: true });
      const replacement = await openRuntimeLog(path, false, errors, 1024);
      replacement.write("new runtime\n");
      await replacement.end();
      expect(await readFile(path, "utf8")).toBe("new runtime\n");
    } finally {
      await log.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
