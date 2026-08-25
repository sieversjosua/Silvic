import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const source = resolve(packageRoot, "dist/silvic.mjs");
const destinationDirectory = resolve(packageRoot, "../../plugins/silvic/bin");
const destination = resolve(destinationDirectory, "silvic.mjs");

await chmod(source, 0o755);
await mkdir(destinationDirectory, { recursive: true });
await cp(source, destination);
const bundledSource = await readFile(destination, "utf8");
await writeFile(destination, bundledSource.replace(/[\t ]+$/gm, ""));
await chmod(destination, 0o755);
