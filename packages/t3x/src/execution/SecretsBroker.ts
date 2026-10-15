/**
 * Secrets broker (report §6 "Security and credential portability").
 *
 * Configuration portability is deliberately separate from credential
 * portability. Secret values are stored centrally on the VPS, encrypted at
 * rest (AES-256-GCM with a locally held key file), and a task only receives
 * the secrets its resolved environment profile references.
 *
 * Enforced here:
 *  - secret values never appear in events, logs or workspace files;
 *  - a profile can only materialize secret refs its policy allows;
 *  - `redact()` scrubs known values from any text leaving the control plane.
 *
 * The sandbox provider's own API key is never materialized into a sandbox.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SecretNotFoundError, SecretPolicyViolationError } from "../contracts/errors.js";
import type { SecretRef } from "../contracts/environmentProfile.js";
import type { EventStore } from "./EventStore.js";

export interface SecretPolicy {
  hostAllowlist: string[];
  allowedProfiles: string[] | null;
  envInjectable: boolean;
}

export const DEFAULT_SECRET_POLICY: SecretPolicy = {
  hostAllowlist: [],
  allowedProfiles: null,
  envInjectable: true,
};

export interface MaterializedSecret {
  name: string;
  secretRef: string;
  value: string;
  inject: "env" | "headers";
  /** Hosts a header-injected secret may be substituted for. */
  hostAllowlist: string[];
}

export class SecretsBroker {
  private readonly key: Buffer;
  private readonly knownValues = new Set<string>();

  constructor(
    private readonly store: EventStore,
    keyFile: string,
  ) {
    this.key = loadOrCreateKey(keyFile);
  }

  put(name: string, value: string, policy: Partial<SecretPolicy> = {}): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString(
      "base64",
    );
    const tag = cipher.getAuthTag().toString("base64");
    this.store.putSecretCipher(
      name,
      { ciphertext, iv: iv.toString("base64"), tag },
      { ...DEFAULT_SECRET_POLICY, ...policy },
    );
    this.knownValues.add(value);
  }

  has(name: string): boolean {
    return this.store.getSecretCipher(name) !== null;
  }

  /** The names in the store — never a value, and never a policy. */
  listNames(): string[] {
    return this.store.listSecretNames();
  }

  get(name: string, profileId: string): string {
    const row = this.store.getSecretCipher(name);
    if (!row) throw new SecretNotFoundError(name);
    const policy = (row.policy ?? DEFAULT_SECRET_POLICY) as SecretPolicy;
    if (policy.allowedProfiles && !policy.allowedProfiles.includes(profileId)) {
      throw new SecretPolicyViolationError(
        `profile ${profileId} may not materialize secret ${name}`,
        { name, profileId },
      );
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.iv, "base64"));
    decipher.setAuthTag(Buffer.from(row.tag, "base64"));
    const value = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    this.knownValues.add(value);
    return value;
  }

  /** Resolve a profile's secret references into values for sandbox injection. */
  materialize(refs: SecretRef[], profileId: string): MaterializedSecret[] {
    const out: MaterializedSecret[] = [];
    for (const ref of refs) {
      const row = this.store.getSecretCipher(ref.secretRef);
      if (!row) {
        throw new SecretPolicyViolationError(`profile references unknown secret ${ref.secretRef}`, {
          secretRef: ref.secretRef,
          profileId,
        });
      }
      const policy = (row.policy ?? DEFAULT_SECRET_POLICY) as SecretPolicy;
      if (ref.inject === "env" && !policy.envInjectable) {
        throw new SecretPolicyViolationError(
          `secret ${ref.secretRef} may not be injected into process environments`,
          { secretRef: ref.secretRef },
        );
      }
      if (
        ref.hostAllowlist.length > 0 &&
        policy.hostAllowlist.length > 0 &&
        !ref.hostAllowlist.every((h) => policy.hostAllowlist.includes(h))
      ) {
        throw new SecretPolicyViolationError(
          `secret ${ref.secretRef} host allowlist is narrower than requested`,
          { secretRef: ref.secretRef, requested: ref.hostAllowlist },
        );
      }
      out.push({
        name: ref.name,
        secretRef: ref.secretRef,
        value: this.get(ref.secretRef, profileId),
        inject: ref.inject,
        hostAllowlist: [...ref.hostAllowlist],
      });
    }
    return out;
  }

  /** Strip known secret values from any text leaving the control plane. */
  redact(text: string): string {
    let out = text;
    for (const value of this.knownValues) {
      if (value.length >= 6) out = out.split(value).join("***");
    }
    return out.replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{8,})\b/g, "***");
  }
}

function loadOrCreateKey(keyFile: string): Buffer {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  if (fs.existsSync(keyFile)) {
    return Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
  }
  const key = randomBytes(32);
  fs.writeFileSync(keyFile, key.toString("base64"), { mode: 0o600 });
  return key;
}
