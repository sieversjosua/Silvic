import {
  closeSync,
  createWriteStream,
  fstatSync,
  openSync,
  readSync,
  watch,
} from "node:fs";
import { open, writeFile, type FileHandle } from "node:fs/promises";

export const runtimeLogLimitBytes = 20 * 1024 * 1024;

/** Read a bounded suffix, keeping the existing character-count API. */
export async function readLogTail(
  path: string,
  characters = 20_000,
): Promise<string> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, characters * 4));
    const { bytesRead } = await file.read(
      buffer,
      0,
      buffer.length,
      size - buffer.length,
    );
    return buffer.subarray(0, bytesRead).toString("utf8").slice(-characters);
  } finally {
    await file.close();
  }
}

export function readLogTailSync(path: string, characters = 20_000): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, characters * 4));
    const bytesRead = readSync(
      fd,
      buffer,
      0,
      buffer.length,
      size - buffer.length,
    );
    return buffer.subarray(0, bytesRead).toString("utf8").slice(-characters);
  } finally {
    closeSync(fd);
  }
}

export interface RuntimeLog {
  fd: number;
  write(text: string): void;
  end(): Promise<void>;
}

/**
 * Children inherit an append-only regular file, so they survive desktop quits.
 * Copy/truncate preserves that inode and descriptor when the log rotates.
 */
export async function openRuntimeLog(
  path: string,
  append: boolean,
  onError: (error: unknown) => void,
  limitBytes = runtimeLogLimitBytes,
): Promise<RuntimeLog> {
  const file = await open(path, "a+");
  try {
    if (!append) await file.truncate(0);
    await rotate(file, path, limitBytes);
    const stream = createWriteStream(path, { fd: file.fd, autoClose: false });
    stream.on("error", onError);
    let timer: NodeJS.Timeout | undefined;
    let maintenance = Promise.resolve();
    let ending: Promise<void> | undefined;
    const watcher = watch(path, () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        maintenance = maintenance
          .then(() => rotate(file, path, limitBytes))
          .catch(onError);
      }, 250);
      timer.unref();
    });
    watcher.on("error", onError);
    watcher.unref();
    return {
      fd: file.fd,
      write: (text) => {
        stream.write(text);
      },
      end: () => {
        if (ending) return ending;
        watcher.close();
        if (timer) clearTimeout(timer);
        const finished =
          stream.destroyed || stream.writableFinished
            ? Promise.resolve()
            : new Promise<void>((resolve) => stream.end(resolve));
        ending = finished
          .then(() => maintenance)
          .then(() => rotate(file, path, limitBytes))
          .catch(onError)
          .then(() => file.close())
          .catch(onError);
        return ending;
      },
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function rotate(
  file: FileHandle,
  path: string,
  limitBytes: number,
): Promise<void> {
  const size = (await file.stat()).size;
  if (size <= limitBytes) return;
  const buffer = Buffer.alloc(limitBytes);
  const { bytesRead } = await file.read(
    buffer,
    0,
    buffer.length,
    size - buffer.length,
  );
  await writeFile(`${path}.1`, buffer.subarray(0, bytesRead));
  await file.truncate(0);
}
