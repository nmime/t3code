/**
 * Unit: sandbox scope resolution and sandbox compatibility.
 *
 * The revised model (one sandbox per project/repo by default, a dedicated
 * sandbox on request) is decided by exactly one function, so its rules are
 * pinned here: resolution order, the repository requirement, administrator
 * isolation, and what makes two tasks compatible enough to share a sandbox.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SANDBOX_SCOPE,
  projectIdForRepository,
  resolveSandboxScope,
  sandboxCompatibilityKey,
  worktreeBranchFor,
  worktreePathFor,
  type ProjectExecutionPolicy,
} from "../../src/contracts/sandboxScope.js";
import { resolveProfile, parsePolicy } from "../../src/contracts/environmentProfile.js";
import { testProfile } from "../helpers.js";

function profile(overrides: Record<string, unknown> = {}, policy?: Record<string, unknown>) {
  return resolveProfile({
    profileId: "p",
    layers: [{ source: "global", name: "g", patch: testProfile(overrides) as never }],
    ...(policy ? { policy: parsePolicy(policy) } : {}),
  });
}

function project(overrides: Partial<ProjectExecutionPolicy> = {}): ProjectExecutionPolicy {
  return {
    projectId: "prj_1",
    name: "backend",
    repositoryUrl: "git@example.com:team/backend.git",
    defaultScope: null,
    environmentProfileId: "p",
    maxConcurrentTasks: 4,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("default is a shared sandbox per project", () => {
  assert.equal(DEFAULT_SANDBOX_SCOPE, "project");
  const resolved = resolveSandboxScope({
    profile: profile(),
    repositoryUrl: "git@example.com:team/backend.git",
  });
  assert.equal(resolved.scope, "project");
  assert.equal(resolved.reason, "global_default");
  assert.ok(resolved.compatibilityKey);
});

test("resolution order: task request, then project default, then global default", () => {
  const repo = "git@example.com:team/backend.git";

  // Global default (profile) applies when the project sets none.
  assert.equal(resolveSandboxScope({ profile: profile(), repositoryUrl: repo }).scope, "project");

  // A profile that asks for per-task isolation changes the global default.
  const perTask = profile({ sandbox: { isolation: "per-task" } });
  assert.equal(
    resolveSandboxScope({ profile: perTask, repositoryUrl: repo }).scope,
    "task",
  );

  // The project default sits above the global default.
  const projectDefaultTask = resolveSandboxScope({
    profile: perTask,
    project: project({ defaultScope: "project" }),
    repositoryUrl: repo,
  });
  assert.equal(projectDefaultTask.scope, "project");
  assert.equal(projectDefaultTask.reason, "project_default");

  // The task's explicit preference wins over both.
  const explicit = resolveSandboxScope({
    requested: "task",
    profile: profile(),
    project: project({ defaultScope: "project" }),
    repositoryUrl: repo,
  });
  assert.equal(explicit.scope, "task");
  assert.equal(explicit.reason, "task_override");

  const explicitShared = resolveSandboxScope({
    requested: "project",
    profile: perTask,
    project: project({ defaultScope: "task" }),
    repositoryUrl: repo,
  });
  assert.equal(explicitShared.scope, "project");
  assert.equal(explicitShared.reason, "task_override");
});

test("administrator policy forbids shared sandboxes and cannot be overridden", () => {
  const resolved = resolveSandboxScope({
    requested: "project",
    profile: profile({}, { requireTaskIsolation: true }),
    project: project({ defaultScope: "project" }),
    repositoryUrl: "git@example.com:team/backend.git",
  });
  assert.equal(resolved.scope, "task");
  assert.equal(resolved.reason, "policy_requires_task_isolation");
});

test("a task with no repository gets a dedicated sandbox", () => {
  const resolved = resolveSandboxScope({ profile: profile(), repositoryUrl: "" });
  assert.equal(resolved.scope, "task");
  assert.equal(resolved.reason, "no_repository");
  assert.equal(resolved.compatibilityKey, null);
});

test("compatibility key covers repository, profile, snapshot and credential domain", () => {
  const repo = "git@example.com:team/backend.git";
  const base = profile();
  const key = sandboxCompatibilityKey({ profile: base, repositoryUrl: repo });

  // Same repository, same resolved profile: shareable.
  assert.equal(sandboxCompatibilityKey({ profile: profile(), repositoryUrl: repo }), key);

  // Different repository: not shareable.
  assert.notEqual(
    sandboxCompatibilityKey({ profile: base, repositoryUrl: "git@example.com:team/other.git" }),
    key,
  );

  // Different snapshot/OS requirement: not shareable.
  assert.notEqual(
    sandboxCompatibilityKey({
      profile: profile({ runtime: { snapshot: "node24-dev-v4", resources: { cpu: 2, memoryGiB: 4 } } }),
      repositoryUrl: repo,
    }),
    key,
  );

  // Different credential trust domain: not shareable, even with the same
  // profile body — separate worktrees are not a security boundary.
  assert.notEqual(
    sandboxCompatibilityKey({ profile: base, repositoryUrl: repo, secretNames: ["A_TOKEN"] }),
    key,
  );
  assert.equal(
    sandboxCompatibilityKey({ profile: base, repositoryUrl: repo, secretNames: ["A_TOKEN"] }),
    sandboxCompatibilityKey({ profile: base, repositoryUrl: repo, secretNames: ["A_TOKEN"] }),
  );
});

test("project identity is derived from the repository", () => {
  assert.equal(
    projectIdForRepository("git@example.com:team/backend.git"),
    projectIdForRepository("git@example.com:team/backend.git"),
  );
  assert.notEqual(
    projectIdForRepository("git@example.com:team/backend.git"),
    projectIdForRepository("git@example.com:team/frontend.git"),
  );
});

test("worktrees live beside the base checkout and on their own branch", () => {
  assert.equal(worktreePathFor("/workspace/project", "task_1"), "/workspace/worktrees/task_1");
  assert.equal(worktreeBranchFor("task_1"), "t3x/task_1");
});
