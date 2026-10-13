import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_POLICY,
  parseProfile,
  parseProfileYaml,
  resolveProfile,
  repositoryAllowed,
  verifyProfileDigest,
  ProfileValidationError,
} from "../../src/contracts/environmentProfile.js";

const base = {
  apiVersion: "t3x/v1",
  kind: "EnvironmentProfile",
  metadata: { name: "typescript-backend", version: 3 },
  runtime: { snapshot: "node24-dev-v3", resources: { cpu: 4, memoryGiB: 8 } },
  project: {
    workingDirectory: "/workspace/project",
    setup: ["corepack enable", "pnpm install --frozen-lockfile"],
    allowedRepositories: ["github.com/nmime/backend"],
  },
  environment: { NODE_ENV: "development", CI: "true" },
  secrets: [{ name: "NPM_TOKEN", secretRef: "npm-registry-readonly" }],
  agents: { allowed: ["codex", "claude"], defaults: { provider: "codex" } },
  configuration: { sources: [{ profile: "global-agent-config-v2" }] },
  sandbox: { isolation: "per-task", stopAfterIdleMinutes: 30, deleteAfterCompletedHours: 48 },
} as const;

test("parses the profile format from the report", () => {
  const profile = parseProfile(base);
  assert.equal(profile.metadata.name, "typescript-backend");
  assert.equal(profile.runtime.resources.cpu, 4);
  assert.equal(profile.project.setup.length, 2);
  assert.deepEqual(profile.agents.allowed, ["codex", "claude"]);
});

test("rejects an invalid profile with actionable issues", () => {
  assert.throws(
    () => parseProfile({ apiVersion: "t3x/v1", kind: "EnvironmentProfile" }),
    (err: unknown) => err instanceof ProfileValidationError,
  );
});

test("still parses profiles written under the old api version", () => {
  // The profile contract was named after OpenSandbox before the deployment moved
  // to a self-hosted sandbox provider; stored profiles must keep working.
  const profile = parseProfile({ ...base, apiVersion: "t3-daytona/v1" });
  assert.equal(profile.metadata.name, "typescript-backend");
  assert.equal(profile.apiVersion, "t3-daytona/v1");
});

test("parses YAML profiles", () => {
  const yaml = `
apiVersion: t3x/v1
kind: EnvironmentProfile
metadata:
  name: from-yaml
  version: 1
runtime:
  snapshot: node24-dev-v3
project:
  workingDirectory: /workspace/project
`;
  const profile = parseProfileYaml(yaml);
  assert.equal(profile.metadata.name, "from-yaml");
  // defaults are filled in
  assert.equal(profile.sandbox.stopAfterIdleMinutes, 30);
});

test("layers profiles with task overrides winning and setup steps concatenating", () => {
  const resolved = resolveProfile({
    profileId: "typescript-backend",
    layers: [
      { source: "base", name: "node24-dev-v3", patch: { runtime: { snapshot: "node24-dev-v3" } } },
      { source: "global", name: "global", patch: base as never },
      {
        source: "project",
        name: "project",
        patch: {
          project: { setup: ["pnpm prisma generate"] } as never,
          environment: { PROJECT_FLAG: "1" },
        },
      },
      {
        source: "task",
        name: "task-overrides",
        patch: {
          runtime: { resources: { cpu: 8, memoryGiB: 16 } } as never,
          environment: { NODE_ENV: "test" },
        },
      },
    ],
  });

  assert.equal(resolved.body.runtime.resources.cpu, 8);
  assert.equal(resolved.body.environment.NODE_ENV, "test");
  assert.equal(resolved.body.environment.PROJECT_FLAG, "1");
  assert.deepEqual(resolved.body.project.setup, [
    "corepack enable",
    "pnpm install --frozen-lockfile",
    "pnpm prisma generate",
  ]);
  assert.equal(resolved.layers.length, 4);
  assert.match(resolved.digest, /^[0-9a-f]{64}$/);
});

test("policy enforcement cannot be overridden by task overrides", () => {
  const policy = {
    ...DEFAULT_POLICY,
    maxCpu: 4,
    maxMemoryGiB: 8,
    allowedSecrets: [],
    allowedAgents: ["codex"],
    allowedRepositories: ["github.com/other/*"],
    deniedEnvKeys: ["AWS_SECRET_ACCESS_KEY"],
  };

  const resolved = resolveProfile({
    profileId: "typescript-backend",
    layers: [
      { source: "global", name: "global", patch: base as never },
      {
        source: "task",
        name: "task",
        patch: {
          runtime: { resources: { cpu: 32, memoryGiB: 128 } } as never,
          environment: { AWS_SECRET_ACCESS_KEY: "should-be-removed" },
          agents: { allowed: ["claude", "opencode"] },
        },
      },
    ],
    policy,
  });

  assert.equal(resolved.body.runtime.resources.cpu, 4, "cpu clamped to policy maximum");
  assert.equal(resolved.body.runtime.resources.memoryGiB, 8);
  assert.equal(resolved.body.environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.deepEqual(resolved.body.agents.allowed, ["codex"]);
  assert.deepEqual(resolved.body.secrets, [], "policy removed the secret reference");
  assert.ok(resolved.warnings.length >= 3);
});

test("repository allowlist is enforced with glob patterns", () => {
  assert.ok(repositoryAllowed("github.com/nmime/backend", ["github.com/nmime/*"]));
  assert.ok(!repositoryAllowed("github.com/other/backend", ["github.com/nmime/*"]));
  assert.ok(repositoryAllowed("anything", null));
});

test("pinned profile digest detects edits", () => {
  const resolved = resolveProfile({
    profileId: "p",
    layers: [{ source: "global", name: "g", patch: base as never }],
  });
  assert.ok(verifyProfileDigest(resolved, resolved.digest));
  const tampered = structuredClone(resolved);
  tampered.body.environment.NODE_ENV = "production";
  assert.ok(!verifyProfileDigest(tampered, resolved.digest));
});

test("warns about macOS-specific setup steps", () => {
  const resolved = resolveProfile({
    profileId: "p",
    layers: [
      {
        source: "global",
        name: "g",
        patch: {
          ...(base as unknown as Record<string, unknown>),
          project: {
            workingDirectory: "/workspace/project",
            setup: ["brew install jq"],
            allowedRepositories: [],
          },
        } as never,
      },
    ],
  });
  assert.ok(resolved.warnings.some((w) => w.includes("macOS-specific")));
});

test("runtime.snapshot is optional: an image-backed profile parses and resolves", () => {
  const parsed = parseProfile({
    ...(base as unknown as Record<string, unknown>),
    runtime: { resources: { cpu: 2, memoryGiB: 4 } },
  });
  assert.equal(parsed.runtime.snapshot, undefined);
  // Defaults still apply, so the backend has resources to send with the image.
  assert.deepEqual(parsed.runtime.resources, { cpu: 2, memoryGiB: 4, diskGiB: 20 });

  const resolved = resolveProfile({
    profileId: "image-backed",
    layers: [
      {
        source: "global",
        name: "g",
        patch: {
          apiVersion: "t3x/v1",
          kind: "EnvironmentProfile",
          metadata: { name: "image-backed", version: 1 },
          runtime: { resources: { cpu: 2, memoryGiB: 4 } },
        } as never,
      },
    ],
  });
  assert.equal(resolved.body.runtime.snapshot, undefined);
  assert.ok(resolved.digest.length > 0);
  assert.ok(verifyProfileDigest(resolved, resolved.digest));
});
