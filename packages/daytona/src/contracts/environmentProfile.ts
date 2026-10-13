/**
 * Environment Profiles (report §3).
 *
 * A versioned, reusable definition of everything a task needs to execute:
 * runtime image and resources, project setup, plain environment values,
 * secret *references*, allowed agents, reusable configuration sources
 * (skills / MCP / provider settings) and sandbox policy.
 *
 * Layers, lowest precedence first:
 *
 *   base snapshot -> global profile -> project configuration -> task overrides
 *
 * followed by policy enforcement, applied last and never overridable. The
 * resolved profile is pinned (content digest) when a task is created, so the
 * task stays reproducible after the global configuration changes.
 */

import { z } from "zod";
import YAML from "yaml";
import { canonicalize } from "./canonical.js";
import { sha256Hex } from "./ids.js";
import { ExecutionError } from "./errors.js";

export const PROFILE_API_VERSION = "t3x/v1";

/**
 * Versions the parser still accepts. The profile contract was named after
 * Daytona before the deployment moved to a self-hosted sandbox provider;
 * profiles written then keep working instead of failing to parse.
 */
export const PROFILE_API_VERSION_ALIASES = ["t3-daytona/v1"] as const;

/**
 * T3's runtime modes, weakest first. The order is the comparison: a profile
 * caps a turn by naming the strongest mode it permits, and a stricter layer
 * can only lower that.
 */
export const RUNTIME_MODE_STRENGTH = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export type RuntimeModeName = (typeof RUNTIME_MODE_STRENGTH)[number];

export const SecretRefSchema = z.object({
  name: z.string().min(1),
  secretRef: z.string().min(1),
  inject: z.enum(["env", "headers"]).default("env"),
  hostAllowlist: z.array(z.string()).default([]),
});

export const ResourcesSchema = z.object({
  cpu: z.number().int().positive().default(2),
  memoryGiB: z.number().int().positive().default(4),
  diskGiB: z.number().int().positive().default(20),
});

export const ProfileBodySchema = z.object({
  apiVersion: z.union([z.literal(PROFILE_API_VERSION), z.literal(PROFILE_API_VERSION_ALIASES[0])]),
  kind: z.literal("EnvironmentProfile"),
  metadata: z.object({
    name: z.string().min(1),
    version: z.number().int().positive().default(1),
    description: z.string().optional(),
  }),
  runtime: z.object({
    platform: z.string().default("linux/amd64"),
    /**
     * The snapshot (or image reference) every sandbox of this profile is built
     * from. Optional: with no snapshot the backend creates the sandbox from
     * the deployment's default image (`T3X_DAYTONA_DEFAULT_IMAGE`, or
     * `daytonaio/sandbox:latest`) and sends `resources` directly — which is
     * what a fresh deployment with no snapshots of its own wants. A snapshot
     * fixes cpu/memory/disk, so `resources` are ignored when one is named.
     */
    snapshot: z.string().min(1).optional(),
    resources: ResourcesSchema.default({}),
  }),
  project: z
    .object({
      workingDirectory: z.string().default("/workspace/project"),
      setup: z.array(z.string()).default([]),
      allowedRepositories: z.array(z.string()).default([]),
    })
    .default({}),
  environment: z.record(z.string(), z.string()).default({}),
  secrets: z.array(SecretRefSchema).default([]),
  agents: z
    .object({
      allowed: z.array(z.string()).default([]),
      /**
       * The strongest T3 runtime mode this profile permits, weakest first:
       * approval-required < auto-accept-edits < auto < full-access.
       *
       * Enforced by the control plane, not by the client: a turn asking for
       * more than this is refused before it reaches a sandbox, and the mode a
       * turn actually runs under is recorded with the turn. `full-access` (the
       * default) caps nothing, which is what a deployment that trusts its
       * clients wants.
       */
      maxRuntimeMode: z
        .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
        .default("full-access"),
      defaults: z
        .object({
          provider: z.string().min(1),
          permissionMode: z.enum(["supervised", "auto"]).default("supervised"),
        })
        .partial()
        .default({}),
    })
    .default({}),
  configuration: z
    .object({
      sources: z
        .array(
          z.union([
            z.object({ git: z.string() }),
            z.object({ profile: z.string() }),
            z.object({ path: z.string() }),
          ]),
        )
        .default([]),
    })
    .default({}),
  sandbox: z
    .object({
      /**
       * Global default sandbox scope. `per-project` is the revised default:
       * one sandbox per project/repository, shared by its tasks, each working
       * in its own git worktree. `per-task` keeps the original one-sandbox-per
       * -task behaviour as the default for every task of this profile.
       */
      isolation: z.enum(["per-project", "per-task"]).default("per-project"),
      /** Tasks allowed to share one project sandbox before it spills to a dedicated one. */
      maxConcurrentTasks: z.number().int().positive().default(4),
      stopAfterIdleMinutes: z.number().int().nonnegative().default(30),
      deleteAfterCompletedHours: z.number().int().nonnegative().default(48),
    })
    .default({}),
});

export type ProfileBody = z.infer<typeof ProfileBodySchema>;
export type SecretRef = z.infer<typeof SecretRefSchema>;

export type ProfilePatch = {
  [K in keyof ProfileBody]?: ProfileBody[K] extends object
    ? Partial<ProfileBody[K]>
    : ProfileBody[K];
};

export type ProfileSource = "base" | "global" | "project" | "task";

export interface ProfileLayer {
  source: ProfileSource;
  /** Human-readable origin, e.g. "global-agent-config-v2" or ".t3/agents/". */
  name: string;
  patch: ProfilePatch;
}

/**
 * Administrative restrictions applied after all layers. Neither project
 * configuration nor task overrides may override administrator restrictions on
 * credentials, repository access or dangerous permissions.
 */
export interface PolicyEnforcement {
  maxCpu: number;
  maxMemoryGiB: number;
  maxIdleMinutes: number;
  allowedAgents: string[] | null;
  allowedSecrets: string[] | null;
  allowedRepositories: string[] | null;
  deniedEnvKeys: string[];
  maxSetupSteps: number;
  requireSupervised: boolean;
  /**
   * Administrator switch: forbid shared project sandboxes for this profile.
   * Applies after all layers and cannot be overridden by a project default or
   * a task's explicit request.
   */
  requireTaskIsolation: boolean;
}

export const DEFAULT_POLICY: PolicyEnforcement = {
  maxCpu: 16,
  maxMemoryGiB: 64,
  maxIdleMinutes: 120,
  allowedAgents: null,
  allowedSecrets: null,
  allowedRepositories: null,
  deniedEnvKeys: [
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "SSH_AUTH_SOCK",
  ],
  maxSetupSteps: 64,
  requireSupervised: false,
  requireTaskIsolation: false,
};

export interface ResolvedProfile {
  profileId: string;
  name: string;
  version: number;
  /** sha256 of the canonical resolved profile; pinned into the task binding. */
  digest: string;
  layers: Array<{ source: ProfileSource; name: string }>;
  body: ProfileBody;
  policy: PolicyEnforcement;
  warnings: string[];
}

export class ProfileValidationError extends ExecutionError {
  readonly issues: string[];
  constructor(issues: string[]) {
    super("profile_invalid", `Environment profile invalid: ${issues.join("; ")}`, {
      issues,
    });
    this.name = "ProfileValidationError";
    this.issues = issues;
  }
}

export function parseProfileYaml(text: string): ProfileBody {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new ProfileValidationError([`YAML parse error: ${(err as Error).message}`]);
  }
  return parseProfile(raw);
}

export function parseProfile(raw: unknown): ProfileBody {
  const result = ProfileBodySchema.safeParse(raw);
  if (!result.success) {
    throw new ProfileValidationError(
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return result.data;
}

export const PolicySchema = z.object({
  maxCpu: z.number().int().positive().default(DEFAULT_POLICY.maxCpu),
  maxMemoryGiB: z.number().int().positive().default(DEFAULT_POLICY.maxMemoryGiB),
  maxIdleMinutes: z.number().int().positive().default(DEFAULT_POLICY.maxIdleMinutes),
  allowedAgents: z.array(z.string()).nullable().default(null),
  allowedSecrets: z.array(z.string()).nullable().default(null),
  allowedRepositories: z.array(z.string()).nullable().default(null),
  deniedEnvKeys: z.array(z.string()).default(DEFAULT_POLICY.deniedEnvKeys),
  maxSetupSteps: z.number().int().positive().default(DEFAULT_POLICY.maxSetupSteps),
  requireSupervised: z.boolean().default(DEFAULT_POLICY.requireSupervised),
  requireTaskIsolation: z.boolean().default(DEFAULT_POLICY.requireTaskIsolation),
});

export function parsePolicy(raw: unknown = {}): PolicyEnforcement {
  return PolicySchema.parse(raw ?? {});
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface ResolveProfileInput {
  profileId: string;
  layers: ProfileLayer[];
  policy?: PolicyEnforcement;
}

/**
 * Resolve layered profiles into the exact environment a task will run with.
 *
 *  - scalars: last layer wins (base < global < project < task)
 *  - `environment`: per-key merge, then policy `deniedEnvKeys` removed
 *  - `secrets`: merged by `name`, later layers replace
 *  - `agents.allowed`: union, then intersected with policy allowlist
 *  - `project.setup`: concatenated in layer order, exact duplicates removed
 *  - `project.allowedRepositories`: intersected across layers, then with policy
 *  - resources: task may raise them, policy clamps them (warning emitted)
 */
export function resolveProfile(input: ResolveProfileInput): ResolvedProfile {
  const policy = input.policy ?? DEFAULT_POLICY;
  const warnings: string[] = [];

  if (input.layers.length === 0) {
    throw new ProfileValidationError(["at least one profile layer is required"]);
  }

  const merged: Record<string, unknown> = {};
  const setupSteps: string[] = [];
  const secretsByName = new Map<string, SecretRef>();
  const allowedAgents = new Set<string>();
  let repositoryConstraints: string[] | null = null;
  // The strictest runtime-mode cap any layer asks for, since a project or task
  // layer may tighten what a profile permits but never loosen it.
  let runtimeModeCap: RuntimeModeName | null = null;

  for (const layer of input.layers) {
    const patch = layer.patch as Record<string, unknown>;
    const scalarPatch: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (key === "project") {
        const project = value as Record<string, unknown>;
        const { setup, allowedRepositories, ...rest } = project;
        if (Array.isArray(setup)) {
          for (const step of setup as string[]) {
            if (!setupSteps.includes(step)) setupSteps.push(step);
          }
        }
        if (Array.isArray(allowedRepositories)) {
          const list = allowedRepositories as string[];
          repositoryConstraints =
            repositoryConstraints === null
              ? [...list]
              : repositoryConstraints.filter((r) => list.includes(r));
        }
        scalarPatch.project = rest;
        continue;
      }
      if (key === "secrets") {
        for (const secret of value as SecretRef[]) secretsByName.set(secret.name, secret);
        continue;
      }
      if (key === "agents") {
        const agents = value as {
          allowed?: string[];
          defaults?: Record<string, unknown>;
          maxRuntimeMode?: RuntimeModeName;
        };
        for (const a of agents.allowed ?? []) allowedAgents.add(a);
        if (agents.maxRuntimeMode) {
          runtimeModeCap =
            runtimeModeCap === null
              ? agents.maxRuntimeMode
              : RUNTIME_MODE_STRENGTH.indexOf(agents.maxRuntimeMode) <
                  RUNTIME_MODE_STRENGTH.indexOf(runtimeModeCap)
                ? agents.maxRuntimeMode
                : runtimeModeCap;
        }
        if (agents.defaults) {
          scalarPatch.agents = deepMerge((merged.agents as Record<string, unknown>) ?? {}, {
            defaults: agents.defaults,
          });
        }
        continue;
      }
      if (isPlainObject(value) && isPlainObject(merged[key])) {
        scalarPatch[key] = deepMerge(merged[key] as Record<string, unknown>, value);
      } else {
        scalarPatch[key] = value;
      }
    }

    Object.assign(merged, scalarPatch);
  }

  const candidate = deepMerge(merged, {
    project: { setup: setupSteps },
    agents: { allowed: [...allowedAgents] },
  });

  // ---- Policy enforcement (cannot be overridden) -------------------------

  if (repositoryConstraints && policy.allowedRepositories) {
    const allowed = repositoryConstraints.filter((r) => policy.allowedRepositories!.includes(r));
    if (allowed.length !== repositoryConstraints.length) {
      warnings.push("policy.allowedRepositories removed project repository constraints");
    }
    candidate.project = deepMerge((candidate.project as Record<string, unknown>) ?? {}, {
      allowedRepositories: allowed,
    });
  } else if (policy.allowedRepositories) {
    candidate.project = deepMerge((candidate.project as Record<string, unknown>) ?? {}, {
      allowedRepositories: [...policy.allowedRepositories],
    });
  } else if (repositoryConstraints) {
    candidate.project = deepMerge((candidate.project as Record<string, unknown>) ?? {}, {
      allowedRepositories: repositoryConstraints,
    });
  }

  const setup = ((candidate.project as Record<string, unknown>)?.setup as string[]) ?? [];
  if (setup.length > policy.maxSetupSteps) {
    throw new ProfileValidationError([
      `profile defines ${setup.length} setup steps, policy allows ${policy.maxSetupSteps}`,
    ]);
  }

  const denied = new Set(policy.deniedEnvKeys);
  const environment = { ...((candidate.environment as Record<string, string>) ?? {}) };
  for (const key of Object.keys(environment)) {
    if (denied.has(key)) {
      delete environment[key];
      warnings.push(`policy removed denied environment key ${key}`);
    }
  }
  candidate.environment = environment;

  const agentList = [...allowedAgents];
  const effectiveAgents =
    policy.allowedAgents === null
      ? agentList
      : agentList.filter((a) => policy.allowedAgents!.includes(a));
  if (policy.allowedAgents !== null && effectiveAgents.length !== agentList.length) {
    warnings.push("policy.allowedAgents restricted the agent allowlist");
  }
  if (policy.allowedAgents !== null && agentList.length === 0 && policy.allowedAgents.length > 0) {
    effectiveAgents.push(...policy.allowedAgents);
  }
  candidate.agents = deepMerge((candidate.agents as Record<string, unknown>) ?? {}, {
    allowed: effectiveAgents,
    ...(runtimeModeCap === null ? {} : { maxRuntimeMode: runtimeModeCap }),
  });

  const secretList = [...secretsByName.values()].filter((s) => {
    if (policy.allowedSecrets === null) return true;
    const ok = policy.allowedSecrets.includes(s.secretRef);
    if (!ok) warnings.push(`policy removed secret ${s.name} (${s.secretRef})`);
    return ok;
  });
  candidate.secrets = secretList;

  const runtime = (candidate.runtime as Record<string, unknown>) ?? {};
  const resources = (runtime.resources as Record<string, number>) ?? {};
  if (resources.cpu !== undefined && resources.cpu > policy.maxCpu) {
    warnings.push(`cpu ${resources.cpu} clamped to policy maximum ${policy.maxCpu}`);
    resources.cpu = policy.maxCpu;
  }
  if (resources.memoryGiB !== undefined && resources.memoryGiB > policy.maxMemoryGiB) {
    warnings.push(
      `memory ${resources.memoryGiB}GiB clamped to policy maximum ${policy.maxMemoryGiB}GiB`,
    );
    resources.memoryGiB = policy.maxMemoryGiB;
  }
  runtime.resources = resources;
  candidate.runtime = runtime;

  const sandbox = (candidate.sandbox as Record<string, unknown>) ?? {};
  const idle = sandbox.stopAfterIdleMinutes as number | undefined;
  if (idle !== undefined && idle > policy.maxIdleMinutes) {
    warnings.push(
      `stopAfterIdleMinutes ${idle} clamped to policy maximum ${policy.maxIdleMinutes}`,
    );
    sandbox.stopAfterIdleMinutes = policy.maxIdleMinutes;
  }
  candidate.sandbox = sandbox;

  const defaults = (
    (candidate.agents as Record<string, unknown>)?.defaults as Record<string, unknown>
  )?.permissionMode;
  if (policy.requireSupervised && defaults === "auto") {
    warnings.push("policy.requireSupervised forced permissionMode to supervised");
    candidate.agents = deepMerge((candidate.agents as Record<string, unknown>) ?? {}, {
      defaults: { permissionMode: "supervised" },
    });
  }

  const body = parseProfile(candidate);

  for (const step of body.project.setup) {
    if (/\/Users\/|brew |darwin|osx/i.test(step)) {
      warnings.push(`setup step looks macOS-specific: ${step}`);
    }
  }

  const digest = sha256Hex(
    canonicalize({ body, policy: { ...policy } as unknown as Record<string, unknown> }),
  );

  return {
    profileId: input.profileId,
    name: body.metadata.name,
    version: body.metadata.version,
    digest,
    layers: input.layers.map((l) => ({ source: l.source, name: l.name })),
    body,
    policy,
    warnings,
  };
}

/** Digest verification for the pinned copy stored on a task. */
export function verifyProfileDigest(
  resolved: Pick<ResolvedProfile, "body" | "policy">,
  digest: string,
): boolean {
  return (
    sha256Hex(
      canonicalize({
        body: resolved.body,
        policy: resolved.policy as unknown as Record<string, unknown>,
      }),
    ) === digest
  );
}

/** Glob-ish matcher for `allowedRepositories`, e.g. "git.example.com/team/*". */
export function repositoryAllowed(url: string, patterns: string[] | null): boolean {
  if (patterns === null || patterns.length === 0) return true;
  return patterns.some((pattern) => globMatch(pattern, url));
}

export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}
