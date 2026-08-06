import { chmod, readFile, writeFile } from "node:fs/promises";

/**
 * Plot environment files hold provider secrets, so every helper here treats
 * contents as sensitive: files are written 0600, and output destined for a
 * person goes through `sanitizeProvisionOutput` first.
 */

/** Read a file that is allowed to be absent. */
export async function optionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export function environmentKey(line: string): string | undefined {
  return line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
}

export function environmentValue(
  contents: string,
  key: string,
): string | undefined {
  const line = contents
    .split(/\r?\n/)
    .find((candidate) => environmentKey(candidate) === key);
  if (!line) return undefined;
  const value = line.slice(line.indexOf("=") + 1).trim();
  return value.replace(/^(['"])(.*)\1$/, "$2").split(/\s+#\s+/, 1)[0];
}

export function withoutEnvironmentKeys(
  contents: string,
  keys: ReadonlySet<string>,
): string {
  return contents
    .split(/\r?\n/)
    .filter((line) => {
      const key = environmentKey(line);
      return !key || !keys.has(key);
    })
    .join("\n")
    .replace(/\n*$/, "\n");
}

export function setEnvironmentValues(
  contents: string,
  values: Readonly<Record<string, string>>,
): string {
  const keys = new Set(Object.keys(values));
  const base = withoutEnvironmentKeys(contents, keys).trimEnd();
  const additions = Object.entries(values).map(
    ([key, value]) => `${key}=${value}`,
  );
  return [...(base ? [base] : []), ...additions].join("\n") + "\n";
}

export async function writePrivateEnvironment(
  path: string,
  contents: string,
): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

export function sanitizeProvisionOutput(output: string): string {
  const withoutPrivateKeys = output.replace(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  );
  return withoutPrivateKeys
    .split(/\r?\n/)
    .map((line) =>
      /(?:api[_-]?key|secret|token|password|deploy[_-]?key|private[_-]?key|authorization)/i.test(
        line,
      )
        ? "[REDACTED SECRET OUTPUT]"
        : line,
    )
    .join("\n")
    .replace(
      /\b(?:dev|prod|preview):[A-Za-z0-9-]+\|[A-Za-z0-9._~+/-]+=*/g,
      "[REDACTED CONVEX DEPLOY KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[REDACTED JWT]",
    );
}
