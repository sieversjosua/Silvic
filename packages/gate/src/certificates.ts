import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { CA_COMMON_NAME } from "./constants";

const openssl = promisify(execFile);

export interface HostCertificate {
  key: string;
  cert: string;
}

/**
 * All issuance goes through the system LibreSSL. Bundling a JS certificate
 * library would be the daemon's only npm dependency; /usr/bin/openssl ships
 * with every macOS and the daemon must stay self-contained enough to run
 * outside the app bundle.
 */
export class CertificateAuthority {
  private readonly directory: string;
  private readonly certsDirectory: string;
  private readonly cache = new Map<string, Promise<HostCertificate>>();

  constructor(stateDirectory: string) {
    this.directory = join(stateDirectory, "ca");
    this.certsDirectory = join(stateDirectory, "certs");
    mkdirSync(this.directory, { recursive: true });
    mkdirSync(this.certsDirectory, { recursive: true });
  }

  get rootCertificatePath(): string {
    return join(this.directory, "ca.pem");
  }

  private get rootKeyPath(): string {
    return join(this.directory, "ca.key");
  }

  async ensureRoot(): Promise<void> {
    if (this.validFor(this.rootCertificatePath, 30)) return;
    const config = await temporaryFile(
      "silvic-gate-ca.cnf",
      [
        "[req]",
        "distinguished_name = dn",
        "x509_extensions = ca",
        "prompt = no",
        "[dn]",
        `CN = ${CA_COMMON_NAME}`,
        "O = Silvic",
        "[ca]",
        "basicConstraints = critical,CA:TRUE,pathlen:0",
        "keyUsage = critical,keyCertSign,cRLSign",
        "subjectKeyIdentifier = hash",
      ].join("\n"),
    );
    try {
      await openssl("/usr/bin/openssl", [
        "req",
        "-x509",
        "-new",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        "3650",
        "-keyout",
        this.rootKeyPath,
        "-out",
        this.rootCertificatePath,
        "-config",
        config,
      ]);
    } finally {
      rmSync(config, { force: true });
    }
    chmodSync(this.rootKeyPath, 0o600);
  }

  /** Issued on demand from the TLS SNI callback; reissued near expiry. */
  certificateFor(host: string): Promise<HostCertificate> {
    const invalid = invalidHost(host);
    if (invalid) return Promise.reject(invalid);
    const cached = this.cache.get(host);
    if (cached) return cached;
    const issued = this.loadOrIssue(host).catch((error: unknown) => {
      this.cache.delete(host);
      throw error;
    });
    this.cache.set(host, issued);
    return issued;
  }

  /**
   * Exact certificate for an SNI name that is not a durable route yet. The
   * daemon keeps the resulting TLS context in a bounded memory cache; no
   * attacker-controlled hostname is allowed to grow the certificate folder.
   */
  temporaryCertificateFor(host: string): Promise<HostCertificate> {
    const invalid = invalidHost(host);
    if (invalid) return Promise.reject(invalid);
    return this.issueTemporarily(host);
  }

  private async loadOrIssue(host: string): Promise<HostCertificate> {
    const certPath = join(this.certsDirectory, `${host}.pem`);
    const keyPath = join(this.certsDirectory, `${host}.key`);
    if (this.validFor(certPath, 30, [host])) {
      return {
        key: readFileSync(keyPath, "utf8"),
        cert: readFileSync(certPath, "utf8"),
      };
    }
    return this.issue(host, keyPath, certPath);
  }

  private async issueTemporarily(host: string): Promise<HostCertificate> {
    const directory = mkdtempSync(join(tmpdir(), "silvic-gate-leaf-"));
    try {
      return await this.issue(
        host,
        join(directory, "leaf.key"),
        join(directory, "leaf.pem"),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private async issue(
    host: string,
    keyPath: string,
    certPath: string,
  ): Promise<HostCertificate> {
    await this.ensureRoot();
    const workDirectory = mkdtempSync(join(tmpdir(), "silvic-gate-issue-"));
    const request = join(workDirectory, "leaf.csr");
    const extensions = join(workDirectory, "extensions.cnf");
    await writeFile(
      extensions,
      `${[
        "basicConstraints = CA:FALSE",
        "keyUsage = critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage = serverAuth",
        `subjectAltName = DNS:${host}`,
      ].join("\n")}\n`,
    );
    try {
      await openssl("/usr/bin/openssl", [
        "req",
        "-new",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-keyout",
        keyPath,
        "-out",
        request,
        "-subj",
        `/CN=${host}`,
      ]);
      await openssl("/usr/bin/openssl", [
        "x509",
        "-req",
        "-in",
        request,
        "-CA",
        this.rootCertificatePath,
        "-CAkey",
        this.rootKeyPath,
        "-CAcreateserial",
        "-sha256",
        // Under Apple's 398-day cap for trusted server certificates.
        "-days",
        "397",
        "-out",
        certPath,
        "-extfile",
        extensions,
      ]);
    } finally {
      rmSync(workDirectory, { recursive: true, force: true });
    }
    chmodSync(keyPath, 0o600);
    return {
      key: readFileSync(keyPath, "utf8"),
      cert: readFileSync(certPath, "utf8"),
    };
  }

  /** Whether the certificate exists and outlives the given number of days. */
  private validFor(
    certPath: string,
    days: number,
    names: readonly string[] = [],
  ): boolean {
    try {
      const parsed = new X509Certificate(readFileSync(certPath));
      const alternatives = parsed.subjectAltName ?? "";
      return (
        Date.parse(parsed.validTo) - Date.now() > days * 86_400_000 &&
        names.every((name) =>
          name.startsWith("*.")
            ? alternatives
                .split(",")
                .map((alternative) => alternative.trim())
                .includes(`DNS:${name}`)
            : parsed.checkHost(name) !== undefined,
        )
      );
    } catch {
      return false;
    }
  }
}

function invalidHost(host: string): Error | undefined {
  return /^[a-z0-9.-]{1,253}$/i.test(host)
    ? undefined
    : new Error(`Refusing certificate for "${host}"`);
}

async function temporaryFile(name: string, contents: string): Promise<string> {
  const path = join(tmpdir(), name);
  await writeFile(path, `${contents}\n`);
  return path;
}
