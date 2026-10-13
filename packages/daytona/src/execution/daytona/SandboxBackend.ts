/**
 * Sandbox backends (report §5).
 *
 * The control plane talks to this interface only, so the Daytona backend can
 * be swapped for Docker, Kubernetes jobs or SSH workers later without
 * touching agent integrations.
 *
 * Two implementations ship:
 *   - LocalBackend: real, filesystem-and-process backed (tests, local dev)
 *   - DaytonaBackend: maps to the Daytona TypeScript SDK surface (snapshots,
 *     lifecycle, resources, process sessions, secrets, signed preview URLs)
 */

import type { SandboxHandle, SandboxStatus, WorkspaceEntry } from "../../contracts/execution.js";
import { SandboxBackendUnsupportedError } from "../../contracts/errors.js";

/**
 * A credential to materialize for a sandbox. `hostAllowlist` is only
 * meaningful for `inject: "headers"`, where the backend substitutes the value
 * on outbound requests to those hosts instead of putting it in the sandbox.
 */
export interface SandboxSecret {
  name: string;
  value: string;
  inject: "env" | "headers";
  hostAllowlist?: string[];
}

export interface SandboxSpec {
  taskId: string;
  snapshot: string;
  platform: string;
  resources: { cpu: number; memoryGiB: number; diskGiB: number };
  env: Record<string, string>;
  /** Declarative setup commands run once at provisioning. */
  setup: string[];
  workingDirectory: string;
  repository?: { url: string; branch: string };
  secrets: SandboxSecret[];
  stopAfterIdleMinutes: number;
}

/**
 * A preview URL for a user-facing port inside a sandbox.
 *
 * Backends scope these differently: the local backend signs an expiring URL,
 * Daytona issues a token-scoped link, so `expiresAt` is null and the caller
 * must send `token` as `X-Daytona-Preview-Token` when it is not null.
 */
export interface PreviewLink {
  url: string;
  token: string | null;
  expiresAt: number | null;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface SandboxBackend {
  readonly kind: "local" | "daytona";

  create(spec: SandboxSpec): Promise<SandboxHandle>;
  status(sandboxId: string): Promise<SandboxStatus>;
  list(): Promise<SandboxStatus[]>;

  start(sandboxId: string): Promise<void>;
  stop(sandboxId: string): Promise<void>;
  destroy(sandboxId: string): Promise<void>;

  snapshot(sandboxId: string, name: string): Promise<{ id: string }>;
  restoreSnapshot(sandboxId: string, snapshotId: string): Promise<void>;

  exec(sandboxId: string, command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(sandboxId: string, path: string): Promise<Buffer>;
  writeFile(sandboxId: string, path: string, data: Buffer, mode?: number): Promise<void>;
  listDir(sandboxId: string, path: string): Promise<WorkspaceEntry[]>;

  /** Inject materialized credentials for the lifetime of the sandbox. */
  injectSecrets(sandboxId: string, secrets: SandboxSecret[]): Promise<void>;

  /** Agent configuration home (CODEX_HOME / CLAUDE_CONFIG_DIR live under it). */
  homeDir(sandboxId: string): string;

  /**
   * Write configuration files produced by the profile's
   * `configuration.sources`. Paths are sandbox-absolute or `~/`-relative.
   */
  writeConfigFiles(
    sandboxId: string,
    files: Array<{ path: string; content: string; mode?: number }>,
  ): Promise<void>;

  /**
   * Preview URL for a user-facing port. The sandbox-wide preview token grants
   * access to sensitive control ports, so previews must be scoped to a port.
   */
  previewUrl(sandboxId: string, port: number, ttlSeconds: number): Promise<PreviewLink>;
}

export function unsupported(backend: string, operation: string): never {
  throw new SandboxBackendUnsupportedError(backend, operation);
}
