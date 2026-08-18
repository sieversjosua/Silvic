import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
    if (!/^[a-z0-9.-]{1,253}$/i.test(host)) {
      return Promise.reject(new Error(`Refusing certificate for "${host}"`));
    }
    const cached = this.cache.get(host);
    if (cached) return cached;
    const issued = this.loadOrIssue(host).catch((error: unknown) => {
      this.cache.delete(host);
      throw error;
    });
    this.cache.set(host, issued);
    return issued;
  }

  private async loadOrIssue(host: string): Promise<HostCertificate> {
    const certPath = join(this.certsDirectory, `${host}.pem`);
    const keyPath = join(this.certsDirectory, `${host}.key`);
    if (this.validFor(certPath, 30)) {
      return {
        key: readFileSync(keyPath, "utf8"),
        cert: readFileSync(certPath, "utf8"),
      };
    }
    await this.ensureRoot();
    const request = join(tmpdir(), `silvic-gate-${host}.csr`);
    const extensions = await temporaryFile(
      `silvic-gate-${host}.cnf`,
      [
        "basicConstraints = CA:FALSE",
        "keyUsage = critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage = serverAuth",
        `subjectAltName = DNS:${host}`,
      ].join("\n"),
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
      rmSync(request, { force: true });
      rmSync(extensions, { force: true });
    }
    chmodSync(keyPath, 0o600);
    return {
      key: readFileSync(keyPath, "utf8"),
      cert: readFileSync(certPath, "utf8"),
    };
  }

  /** Whether the certificate exists and outlives the given number of days. */
  private validFor(certPath: string, days: number): boolean {
    try {
      const parsed = new X509Certificate(readFileSync(certPath));
      return Date.parse(parsed.validTo) - Date.now() > days * 86_400_000;
    } catch {
      return false;
    }
  }
}

async function temporaryFile(name: string, contents: string): Promise<string> {
  const path = join(tmpdir(), name);
  await writeFile(path, `${contents}\n`);
  return path;
}
