import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const source = resolve(packageRoot, "dist/silvic.mjs");
const launcherSource = resolve(packageRoot, "bin/silvic");
const destinationDirectory = resolve(packageRoot, "../../plugins/silvic/bin");
const destination = resolve(destinationDirectory, "silvic.mjs");
const launcherDestination = resolve(destinationDirectory, "silvic");

await chmod(source, 0o755);
await mkdir(destinationDirectory, { recursive: true });
const stagingDirectory = await mkdtemp(
  resolve(packageRoot, "dist/plugin-stage-"),
);
try {
  const temporaryDestination = resolve(stagingDirectory, "silvic.mjs");
  const temporaryLauncher = resolve(stagingDirectory, "silvic");
  await cp(source, temporaryDestination);
  const bundledSource = await readFile(temporaryDestination, "utf8");
  await writeFile(temporaryDestination, bundledSource.replace(/[\t ]+$/gm, ""));
  await chmod(temporaryDestination, 0o755);
  await rename(temporaryDestination, destination);
  await cp(launcherSource, temporaryLauncher);
  await chmod(temporaryLauncher, 0o755);
  await rename(temporaryLauncher, launcherDestination);
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
