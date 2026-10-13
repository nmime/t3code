/**
 * Environment Profile service (report §3).
 *
 * Stores versioned profile documents, resolves the layer stack for a new task
 * (base -> global -> project -> task overrides, then policy enforcement) and
 * pins the resolved profile + digest onto the task binding so the task stays
 * reproducible after the global configuration changes.
 */

import {
  parseProfileYaml,
  parsePolicy,
  resolveProfile,
  verifyProfileDigest,
  repositoryAllowed,
  type PolicyEnforcement,
  type ProfileBody,
  type ProfileLayer,
  type ResolvedProfile,
} from "../contracts/environmentProfile.js";
import { ProfileNotFoundError, ExecutionError } from "../contracts/errors.js";
import { sha256Hex } from "../contracts/ids.js";
import { canonicalize } from "../contracts/canonical.js";
import type { EventStore } from "./EventStore.js";

export interface CreateProfileInput {
  profileId: string;
  body: ProfileBody | string;
  policy?: unknown;
}

export interface ResolveForTaskInput {
  profileId: string;
  /** Project-level patch, e.g. from `.t3/agents/` inside the repository. */
  projectPatch?: ProfileLayer["patch"];
  projectName?: string;
  /** Per-task overrides: provider, model, env vars, resources. */
  taskOverrides?: ProfileLayer["patch"];
  repositoryUrl: string;
}

export class EnvironmentProfileService {
  private policy: PolicyEnforcement;

  constructor(
    private readonly store: EventStore,
    policy: unknown = {},
  ) {
    this.policy = parsePolicy(policy);
  }

  setPolicy(policy: unknown): void {
    this.policy = parsePolicy(policy);
  }

  getPolicy(): PolicyEnforcement {
    return this.policy;
  }

  createProfile(input: CreateProfileInput): {
    profileId: string;
    version: number;
    digest: string;
  } {
    const body = typeof input.body === "string" ? parseProfileYaml(input.body) : input.body;
    const digest = sha256Hex(canonicalize(body));
    const existing = this.store.listProfiles().filter((p) => p.profileId === input.profileId);
    const version =
      existing.length === 0
        ? body.metadata.version
        : Math.max(...existing.map((p) => p.version)) + 1;
    this.store.saveProfile(input.profileId, version, body, digest);
    return { profileId: input.profileId, version, digest };
  }

  getProfile(profileId: string, version?: number): { body: ProfileBody; digest: string } {
    const stored = this.store.getProfile(profileId, version);
    if (!stored) throw new ProfileNotFoundError(profileId);
    return { body: stored.body as ProfileBody, digest: stored.digest };
  }

  listProfiles(): Array<{ profileId: string; version: number; digest: string }> {
    return this.store.listProfiles();
  }

  /** Resolve the full layer stack for a task and pin the result. */
  resolveForTask(input: ResolveForTaskInput): ResolvedProfile {
    const stored = this.getProfile(input.profileId);
    const layers: ProfileLayer[] = [
      {
        source: "base",
        name: stored.body.runtime.snapshot ?? "default-image",
        patch: basePatch(stored.body),
      },
      {
        source: "global",
        name: `${input.profileId}@${stored.digest.slice(0, 8)}`,
        patch: stored.body as ProfileLayer["patch"],
      },
    ];
    if (input.projectPatch) {
      layers.push({
        source: "project",
        name: input.projectName ?? "project",
        patch: input.projectPatch,
      });
    }
    if (input.taskOverrides) {
      layers.push({ source: "task", name: "task-overrides", patch: input.taskOverrides });
    }

    const resolved = resolveProfile({
      profileId: input.profileId,
      layers,
      policy: this.policy,
    });

    if (
      !repositoryAllowed(
        input.repositoryUrl,
        resolved.body.project.allowedRepositories.length > 0
          ? resolved.body.project.allowedRepositories
          : null,
      )
    ) {
      throw new ExecutionError(
        "secret_policy_violation",
        `Repository ${input.repositoryUrl} is not in the profile allowlist.`,
        { repositoryUrl: input.repositoryUrl },
      );
    }

    return resolved;
  }

  /** Re-verify a pinned digest before reusing a stored profile (recovery path). */
  verifyPinned(resolved: ResolvedProfile): boolean {
    return verifyProfileDigest(resolved, resolved.digest);
  }
}

/** The base layer contributes runtime defaults only. */
function basePatch(body: ProfileBody): ProfileLayer["patch"] {
  return {
    apiVersion: body.apiVersion,
    kind: body.kind,
    runtime: {
      platform: body.runtime.platform,
      // Omitted (not `undefined`) so an image-backed profile does not shadow a
      // snapshot a later layer adds.
      ...(body.runtime.snapshot ? { snapshot: body.runtime.snapshot } : {}),
    },
  } as ProfileLayer["patch"];
}
