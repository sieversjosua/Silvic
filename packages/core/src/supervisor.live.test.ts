import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { afterAll, expect, it } from "vitest";

import {
  CommandSupervisor,
  type SupervisedCommand,
} from "./command-supervisor";

const directories: string[] = [];

afterAll(async () => {
  // Whatever this test started is detached, so it outlives the runner unless
  // it is ended here.
  try {
    execFileSync("sh", ["-lc", `lsof -ti :${port} | xargs -r kill -9`], {
      stdio: "ignore",
    });
  } catch {
    // Nothing was listening, which is the state being asked for.
  }
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
// A fresh port each run, so a leaked server from a previous one cannot make
// this look like a failure of the thing being tested.
const port = 4600 + Math.floor(Math.random() * 300);

it("starts a real command, stops its whole group, and is taken back", async () => {
  const plot = await mkdtemp(join(tmpdir(), "silvic-live-"));
  const logs = await mkdtemp(join(tmpdir(), "silvic-logs-"));
  directories.push(plot, logs);
  await writeFile(join(plot, "index.html"), "<h1>plot</h1>");

  let announced: readonly SupervisedCommand[] = [];
  const supervisor = new CommandSupervisor({
    logDirectory: logs,
    onChange: (processes) => {
      announced = processes;
    },
  });

  await supervisor.start({
    plotPath: plot,
    id: "web",
    command: {
      run: "python3 -m http.server $PORT",
      url: true,
      portless: false,
    },
    routeName: "silvic-live-check",
    environment: {
      PORT: String(port),
      SILVIC_URL: `http://localhost:${port}`,
    },
    canRoute: false,
    detached: true,
  });

  const started = supervisor.list()[0];
  expect(started?.status).toBe("running");
  expect(announced).toHaveLength(1);

  await settle(500);
  const afterPublishing = supervisor.list()[0];
  expect(afterPublishing?.status).toBe("running");
  expect(afterPublishing?.advice).toBeUndefined();
  expect(afterPublishing?.url).toBe(`http://localhost:${port}`);
  const served = execFileSync(
    "curl",
    [
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      `http://127.0.0.1:${port}/`,
    ],
    { encoding: "utf8" },
  );
  expect(served.trim()).toBe("200");

  // A second supervisor, as a new window would be: it should take the running
  // command back rather than offering to start it again.
  let adoptedAnnounce: readonly SupervisedCommand[] = [];
  const reopened = new CommandSupervisor({
    logDirectory: logs,
    onChange: (processes) => {
      adoptedAnnounce = processes;
    },
  });
  reopened.adopt(supervisor.list());
  expect(reopened.list()[0]?.status).toBe("running");
  expect(adoptedAnnounce).toHaveLength(1);

  // And it must refuse an id that is not the process it was.
  const stale = new CommandSupervisor({
    logDirectory: logs,
    onChange: () => {},
  });
  stale.adopt([
    {
      ...(supervisor.list()[0] as SupervisedCommand),
      // The same id, but claiming to have begun last week.
      startedAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    },
  ]);
  expect(stale.list()).toHaveLength(0);

  // Stopping reaches the group: the shell and the server it forked.
  const groupLeader = supervisor.list()[0]?.processId as number;
  expect(groupLeader).toBeGreaterThan(0);
  supervisor.stop(plot, "web");
  await settle(2_500);
  expect(() => process.kill(groupLeader, 0)).toThrow();
  expect(supervisor.list()[0]?.status).not.toBe("running");
  // Nothing is listening on the plot's port any more: the shell, and the
  // server it turned into, went together.
  const listeners = execFileSync("sh", ["-lc", `lsof -ti :${port} | wc -l`], {
    encoding: "utf8",
  });
  expect(listeners.trim()).toBe("0");
}, 60_000);
