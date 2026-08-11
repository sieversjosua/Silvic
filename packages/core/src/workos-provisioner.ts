import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { WorkosStep } from "@silvic/contracts";

import type { CommandRunner } from "./command-runner";
import {
  environmentValue,
  optionalFile,
  sanitizeProvisionOutput,
  setEnvironmentValues,
  writePrivateEnvironment,
} from "./environment-files";
import { workosEmulatePort } from "./ports";
import {
  provisionEnvironment,
  type ProvisionContext,
} from "./provision-environment";

/** Pinned so a recipe keeps working when the emulator's defaults move. */
export const workosEmulateVersion = "0.5.0";

/** The test key the emulator accepts without any seeding. */
const emulatorApiKey = "sk_test_default";

/**
 * The command a recipe supervises to run the emulator. `$SILVIC_WORKOS_PORT`
 * is part of every plot process's environment, so one recipe line serves
 * every plot without naming a port.
 */
export function workosEmulateCommand(seed?: string): string {
  return [
    `npx --yes @workos/emulate@${workosEmulateVersion}`,
    `--port "$SILVIC_WORKOS_PORT"`,
    "--interactive",
    ...(seed ? [`--seed "${seed}"`] : []),
  ].join(" ");
}

/**
 * Owns the emulated WorkOS contract for one plot: the app's `WORKOS_*`
 * variables point at a plot-local emulator, and nothing here ever reaches a
 * real WorkOS environment — no account, no dashboard, no credentials. The
 * emulator process itself is an ordinary supervised command; this step only
 * prepares what that process and the app must agree on.
 */
export class WorkosProvisioner {
  constructor(private readonly runner: CommandRunner) {}

  async run(
    step: WorkosStep,
    context: ProvisionContext,
    options: { signal?: AbortSignal; onOutput?: (chunk: string) => void } = {},
  ): Promise<{ exitCode: number; output: string }> {
    const messages: string[] = [];
    const announce = (message: string): void => {
      messages.push(message);
      options.onOutput?.(`${message}\n`);
    };

    const port =
      step.workos.port ??
      (context.port === undefined
        ? undefined
        : workosEmulatePort(context.port));
    if (port === undefined) {
      return {
        exitCode: 1,
        output:
          "No emulator port: the step names none and the plot's own port is unknown",
      };
    }

    // Fetching the pinned emulator now means an offline machine fails here,
    // visibly, rather than later as a dead runtime with an empty log.
    announce(`Preparing @workos/emulate ${workosEmulateVersion}`);
    const prepared = await this.runner.run({
      executable: "npx",
      arguments: [
        "--yes",
        `@workos/emulate@${workosEmulateVersion}`,
        "--version",
      ],
      cwd: context.root,
      environment: provisionEnvironment(context),
      outputLimit: 100_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (prepared.exitCode !== 0) {
      return {
        exitCode: prepared.exitCode,
        output: [
          ...messages,
          "Preparing the WorkOS emulator failed",
          sanitizeProvisionOutput(
            `${prepared.stdout}${prepared.stderr}`.trim(),
          ),
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    const environmentPath = join(context.root, ".env.local");
    const contents = await optionalFile(environmentPath);
    const redirect = redirectUri(
      contents,
      context.url,
      step.workos.callbackPath,
    );
    const generatedCookiePassword = !environmentValue(
      contents,
      "WORKOS_COOKIE_PASSWORD",
    );
    const namedClient = !environmentValue(contents, "WORKOS_CLIENT_ID");
    await writePrivateEnvironment(
      environmentPath,
      setEnvironmentValues(contents, {
        WORKOS_API_HOSTNAME: "localhost",
        WORKOS_API_PORT: String(port),
        WORKOS_API_HTTPS: "false",
        WORKOS_API_KEY: emulatorApiKey,
        ...(namedClient ? { WORKOS_CLIENT_ID: "client_emulated" } : {}),
        ...(redirect ? { NEXT_PUBLIC_WORKOS_REDIRECT_URI: redirect } : {}),
        ...(generatedCookiePassword
          ? { WORKOS_COOKIE_PASSWORD: randomBytes(32).toString("base64url") }
          : {}),
      }),
    );

    announce(
      `WORKOS_* now points at http://localhost:${port}, keyed with the emulator's test key`,
    );
    if (namedClient) {
      announce("Named the client client_emulated; the emulator accepts any");
    }
    if (redirect) announce(`Callback after login: ${redirect}`);
    if (generatedCookiePassword) {
      announce(
        "Generated WORKOS_COOKIE_PASSWORD; it stays in the plot's .env.local",
      );
    }
    announce("Nothing here reaches a real WorkOS environment");
    return { exitCode: 0, output: messages.join("\n") };
  }
}

/**
 * The redirect URI belongs on the plot's own address. When the copied
 * environment already names one, its path survives — only the origin moves —
 * so an app with an unusual callback route keeps it.
 */
function redirectUri(
  contents: string,
  url: string | undefined,
  callbackPath: string,
): string | undefined {
  if (!url) return undefined;
  const existing = environmentValue(
    contents,
    "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
  );
  const path = (existing ? pathOf(existing) : undefined) ?? callbackPath;
  return new URL(path, url).toString();
}

function pathOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}
