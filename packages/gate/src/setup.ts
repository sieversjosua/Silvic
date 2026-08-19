import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  GATE_HOST,
  GATE_HTTP_PORT,
  GATE_HTTPS_PORT,
  GATE_SCRIPT_NAME,
  LAUNCH_AGENT_LABEL,
  PF_ANCHOR,
  PF_ANCHOR_FILE,
  PF_DAEMON_LABEL,
} from "./constants";
import { gateStateDirectory } from "./state-dir";

const run = promisify(execFile);

/** Only loopback traffic is touched; nothing routed to the network changes. */
export function pfAnchorRules(): string {
  return [
    `rdr pass on lo0 inet proto tcp from any to any port 443 -> 127.0.0.1 port ${GATE_HTTPS_PORT}`,
    `rdr pass on lo0 inet6 proto tcp from any to any port 443 -> ::1 port ${GATE_HTTPS_PORT}`,
    `rdr pass on lo0 inet proto tcp from any to any port 80 -> 127.0.0.1 port ${GATE_HTTP_PORT}`,
    `rdr pass on lo0 inet6 proto tcp from any to any port 80 -> ::1 port ${GATE_HTTP_PORT}`,
    "",
  ].join("\n");
}

/** Reloads the anchor at boot; pf itself holds the rules after that. */
export function pfDaemonPlist(): string {
  return plist(PF_DAEMON_LABEL, {
    programArguments: [
      "/bin/sh",
      "-c",
      `/sbin/pfctl -a '${PF_ANCHOR}' -f '${PF_ANCHOR_FILE}' && /sbin/pfctl -E`,
    ],
    runAtLoad: true,
    keepAlive: false,
  });
}

/**
 * The daemon is the installed Silvic app running as plain Node. The path is
 * stable across updates, so launchd is configured exactly once; KeepAlive
 * restarts the gate whenever an update replaces the script under it.
 */
export function launchAgentPlist({
  nodeExecutable,
  gateScript,
  stateDirectory,
}: {
  nodeExecutable: string;
  gateScript: string;
  stateDirectory: string;
}): string {
  return plist(LAUNCH_AGENT_LABEL, {
    programArguments: [nodeExecutable, gateScript],
    environment: { ELECTRON_RUN_AS_NODE: "1" },
    runAtLoad: true,
    keepAlive: true,
    standardOutPath: join(stateDirectory, "gate.log"),
    standardErrorPath: join(stateDirectory, "gate.log"),
  });
}

/**
 * Everything that needs root, in one reviewable script run behind macOS's
 * native administrator prompt: the pf redirect and its boot loader. Silvic
 * never sees the password. Certificate trust deliberately is NOT here: even
 * root cannot change admin trust settings without an interactive
 * authorization that the osascript context cannot show (-60005), so trust
 * is granted in the user domain instead — see installUserTrust.
 */
export function adminSetupScript(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    "mkdir -p /etc/pf.anchors",
    `cat > '${PF_ANCHOR_FILE}' <<'RULES'`,
    pfAnchorRules().trimEnd(),
    "RULES",
    `chmod 644 '${PF_ANCHOR_FILE}'`,
    `cat > '/Library/LaunchDaemons/${PF_DAEMON_LABEL}.plist' <<'PLIST'`,
    pfDaemonPlist().trimEnd(),
    "PLIST",
    `chown root:wheel '/Library/LaunchDaemons/${PF_DAEMON_LABEL}.plist'`,
    `chmod 644 '/Library/LaunchDaemons/${PF_DAEMON_LABEL}.plist'`,
    `launchctl bootout 'system/${PF_DAEMON_LABEL}' 2>/dev/null || true`,
    `launchctl bootstrap system '/Library/LaunchDaemons/${PF_DAEMON_LABEL}.plist'`,
    `/sbin/pfctl -a '${PF_ANCHOR}' -f '${PF_ANCHOR_FILE}' 2>/dev/null`,
    "/sbin/pfctl -E 2>/dev/null || true",
    "",
  ].join("\n");
}

export interface GateSetupContext {
  /** The Electron binary that runs gate.js as Node. */
  nodeExecutable: string;
  /** Absolute path to the bundled, asar-unpacked gate script. */
  gateScript: string;
  execute?(
    executable: string,
    arguments_: readonly string[],
  ): Promise<{ stdout: string; stderr: string }>;
  /** Injected so tests do not wait out launchd's unload window. */
  wait?(milliseconds: number): Promise<void>;
}

/** How long the install waits for launchd, in steps of this length. */
const LAUNCHCTL_ATTEMPTS = 12;
const LAUNCHCTL_INTERVAL_MS = 250;

/**
 * The unprivileged half: put the LaunchAgent in place and (re)start it.
 *
 * `bootout` returns before launchd has finished unloading the old service,
 * and a `bootstrap` that lands inside that window fails with EIO — which
 * left the machine with the agent removed and no gate running at all, the
 * failure swallowed. So: unload, wait until launchd admits the service is
 * gone, load again, and throw when it never takes, so the caller can fall
 * back to spawning the daemon itself.
 */
export async function installLaunchAgent(
  context: GateSetupContext,
): Promise<void> {
  const execute = context.execute ?? runBounded;
  const wait =
    context.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const stateDirectory = gateStateDirectory();
  const agents = join(homedir(), "Library", "LaunchAgents");
  await mkdir(agents, { recursive: true });
  const plistPath = join(agents, `${LAUNCH_AGENT_LABEL}.plist`);
  await writeFile(
    plistPath,
    launchAgentPlist({
      nodeExecutable: context.nodeExecutable,
      gateScript: context.gateScript,
      stateDirectory,
    }),
  );
  const domain = `gui/${userInfo().uid}`;
  const service = `${domain}/${LAUNCH_AGENT_LABEL}`;
  let refused: unknown;
  const attempt = async (arguments_: readonly string[]): Promise<boolean> => {
    try {
      await execute("launchctl", arguments_);
      return true;
    } catch (error) {
      refused = error;
      return false;
    }
  };

  await attempt(["bootout", service]);
  for (let left = LAUNCHCTL_ATTEMPTS; left > 0; left--) {
    // `print` keeps succeeding while the old service is still on its way out.
    if (!(await attempt(["print", service]))) break;
    await wait(LAUNCHCTL_INTERVAL_MS);
  }
  for (let left = LAUNCHCTL_ATTEMPTS; left > 0; left--) {
    // RunAtLoad starts the daemon as part of a successful bootstrap.
    if (await attempt(["bootstrap", domain, plistPath])) return;
    if (left > 1) await wait(LAUNCHCTL_INTERVAL_MS);
  }
  throw new Error(
    `launchctl would not load the Silvic gate agent from ${plistPath}: ${
      refused instanceof Error ? refused.message : String(refused)
    }`,
  );
}

/**
 * The privileged half, behind the native administrator dialog. The script is
 * staged in the gate's own state directory rather than a world-writable tmp.
 */
export async function installPrivileged(
  context: Pick<GateSetupContext, "execute"> = {},
): Promise<void> {
  const execute = context.execute ?? run;
  const stateDirectory = gateStateDirectory();
  const script = join(stateDirectory, "setup-admin.sh");
  await writeFile(script, adminSetupScript());
  await chmod(script, 0o755);
  // `quoted form of` shell-quotes the path — it lives under "Application
  // Support", and an unquoted space there once broke the whole setup right
  // after the person had typed their password.
  await execute("osascript", [
    "-e",
    `do shell script "/bin/sh " & quoted form of "${appleScriptString(script)}" with administrator privileges`,
  ]);
}

function appleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Trusts the gate's CA in the user domain, where macOS is willing to ask the
 * person directly (its own password dialog) instead of refusing outright as
 * it does for admin trust settings from a script. Browsers honour user-domain
 * roots just the same, and `security verify-cert` — the doctor's check —
 * evaluates them too.
 */
export async function installUserTrust(
  context: Pick<GateSetupContext, "execute"> = {},
): Promise<void> {
  const execute = context.execute ?? run;
  const caCertificate = join(gateStateDirectory(), "ca", "ca.pem");
  await execute("security", [
    "add-trusted-cert",
    "-r",
    "trustRoot",
    caCertificate,
  ]);
}

/**
 * Ends a gate that holds the ports but answers nobody. It happens: a gate
 * spawned directly by the app outlives its launch agent, a successor dies on
 * EADDRINUSE, and the machine is left with two half-gates and no HTTPS —
 * nothing can bind 42443 while the orphan lives. Only Silvic's own daemon is
 * ever stopped; another program on the port is a different diagnosis.
 */
export async function stopOrphanGate(
  context: {
    execute?(
      executable: string,
      arguments_: readonly string[],
    ): Promise<{ stdout: string; stderr: string }>;
    kill?(pid: number, signal: NodeJS.Signals): void;
    wait?(milliseconds: number): Promise<void>;
  } = {},
): Promise<readonly number[]> {
  const execute = context.execute ?? runBounded;
  const kill = context.kill ?? ((pid, signal) => process.kill(pid, signal));
  const wait =
    context.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const holders = async (): Promise<readonly number[]> => {
    let listed: string;
    try {
      // lsof exits non-zero when nothing listens, which is the good case.
      ({ stdout: listed } = await execute("lsof", [
        "-nP",
        `-iTCP:${GATE_HTTPS_PORT}`,
        "-sTCP:LISTEN",
        "-t",
      ]));
    } catch {
      return [];
    }
    const pids = listed
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    const ours: number[] = [];
    for (const pid of new Set(pids)) {
      try {
        const { stdout } = await execute("ps", [
          "-o",
          "command=",
          "-p",
          `${pid}`,
        ]);
        if (stdout.includes(GATE_SCRIPT_NAME)) ours.push(pid);
      } catch {
        // Gone between the two calls; nothing left to stop.
      }
    }
    return ours;
  };

  const orphans = await holders();
  if (orphans.length === 0) return [];
  for (const pid of orphans) attemptKill(kill, pid, "SIGTERM");
  for (let left = LAUNCHCTL_ATTEMPTS; left > 0; left--) {
    if ((await holders()).length === 0) return orphans;
    await wait(LAUNCHCTL_INTERVAL_MS);
  }
  for (const pid of orphans) attemptKill(kill, pid, "SIGKILL");
  await wait(LAUNCHCTL_INTERVAL_MS);
  return orphans;
}

function attemptKill(
  kill: (pid: number, signal: NodeJS.Signals) => void,
  pid: number,
  signal: NodeJS.Signals,
): void {
  try {
    kill(pid, signal);
  } catch {
    // Already gone, or not ours to end.
  }
}

export type GateCheck = "control-socket" | "proxy-443" | "certificate-trusted";

export interface GateDiagnosis {
  healthy: boolean;
  failures: readonly { check: GateCheck; advice: string }[];
}

/**
 * Every prerequisite, verified rather than assumed — including certificate
 * trust, which the portless era famously skipped.
 */
export async function diagnoseGate({
  socketStatus,
  execute,
  probe,
}: {
  /** Whether the control socket answers a status request. */
  socketStatus(): Promise<boolean>;
  execute?(
    executable: string,
    arguments_: readonly string[],
  ): Promise<{ stdout: string; stderr: string }>;
  /** GETs a URL, verifying TLS against the gate CA; resolves ok=false offline. */
  probe(url: string): Promise<boolean>;
}): Promise<GateDiagnosis> {
  const attempt = execute ?? runBounded;
  const failures: { check: GateCheck; advice: string }[] = [];

  if (!(await socketStatus())) {
    failures.push({
      check: "control-socket",
      advice:
        "The Silvic gate is not running. Set up local HTTPS from the plot dialog, or reinstall the gate service.",
    });
  }
  if (!(await probe(`https://${GATE_HOST}/`))) {
    failures.push({
      check: "proxy-443",
      advice:
        "Port 443 does not reach the Silvic gate. The one-time HTTPS setup installs a loopback firewall redirect; run it again if another proxy took the port.",
    });
  }
  const leaf = join(gateStateDirectory(), "certs", `${GATE_HOST}.pem`);
  try {
    await attempt("security", ["verify-cert", "-c", leaf]);
  } catch {
    failures.push({
      check: "certificate-trusted",
      advice:
        "The gate's HTTPS certificate is not trusted yet, so browsers and logins will refuse the preview. Run the one-time HTTPS setup to trust it.",
    });
  }
  return { healthy: failures.length === 0, failures };
}

/** Every command here is a quick local tool; none may hang the setup. */
async function runBounded(
  executable: string,
  arguments_: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return await run(executable, [...arguments_], { timeout: 10_000 });
}

function plist(
  label: string,
  {
    programArguments,
    environment,
    runAtLoad,
    keepAlive,
    standardOutPath,
    standardErrorPath,
  }: {
    programArguments: readonly string[];
    environment?: Readonly<Record<string, string>>;
    runAtLoad: boolean;
    keepAlive: boolean;
    standardOutPath?: string;
    standardErrorPath?: string;
  },
): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...programArguments.map(
      (argument) => `    <string>${escapeXml(argument)}</string>`,
    ),
    "  </array>",
  ];
  if (environment && Object.keys(environment).length > 0) {
    lines.push("  <key>EnvironmentVariables</key>", "  <dict>");
    for (const [name, value] of Object.entries(environment)) {
      lines.push(
        `    <key>${escapeXml(name)}</key>`,
        `    <string>${escapeXml(value)}</string>`,
      );
    }
    lines.push("  </dict>");
  }
  lines.push(
    "  <key>RunAtLoad</key>",
    `  <${runAtLoad}/>`,
    "  <key>KeepAlive</key>",
    `  <${keepAlive}/>`,
  );
  if (standardOutPath) {
    lines.push(
      "  <key>StandardOutPath</key>",
      `  <string>${escapeXml(standardOutPath)}</string>`,
    );
  }
  if (standardErrorPath) {
    lines.push(
      "  <key>StandardErrorPath</key>",
      `  <string>${escapeXml(standardErrorPath)}</string>`,
    );
  }
  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
