/**
 * The one thing the sandbox half of text generation has to get right: which
 * task a prompt belongs to.
 *
 * T3 names the path it has open, and for a sandbox provider that is the *host*
 * checkout — a path no task owns. The thread is the key that lands, and the
 * adapter learns it when a session opens. Getting this wrong is invisible in a
 * unit sense and obvious in use: the thread's title generation answered
 * `task_not_found: no sandbox workspace is /srv/t3-workspace`, every time.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Effect from "effect/Effect";

import { rememberThreadWorkspace, threadForWorkspace } from "./adapter.ts";
import type { OpenSandboxControlPlane } from "./controlPlane.ts";
import { makeSandboxTextGeneration } from "./driver.ts";

test("a generation prompt names the thread whose host checkout it is", async () => {
  rememberThreadWorkspace("/srv/t3-workspace", "thread_from_app");
  assert.equal(threadForWorkspace("/srv/t3-workspace/"), "thread_from_app");

  const calls: Array<{ cwd: string; threadId?: string; prompt: string }> = [];
  const client = {
    generateText: async (input: { cwd: string; threadId?: string; prompt: string }) => {
      calls.push(input);
      return JSON.stringify({ title: "A generated title", needsRefinement: false });
    },
  } as unknown as OpenSandboxControlPlane;

  const result = await Effect.runPromise(
    makeSandboxTextGeneration(client).generateThreadTitle({
      cwd: "/srv/t3-workspace",
      message: "what should we build",
      modelSelection: { instanceId: "opensandbox", model: "default" },
    } as never),
  );

  assert.equal(result.title, "A generated title", "the reply is decoded as usual");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.threadId,
    "thread_from_app",
    "the thread travels with the prompt, because the path is the host's",
  );
  assert.equal(calls[0]?.cwd, "/srv/t3-workspace", "the path still travels, as the fallback key");
});

test("a checkout no session has claimed is sent without a thread", async () => {
  const calls: Array<{ cwd: string; threadId?: string }> = [];
  const client = {
    generateText: async (input: { cwd: string; threadId?: string }) => {
      calls.push(input);
      return JSON.stringify({ title: "Another title" });
    },
  } as unknown as OpenSandboxControlPlane;

  await Effect.runPromise(
    makeSandboxTextGeneration(client).generateThreadTitle({
      cwd: "/workspace/project",
      message: "hello",
      modelSelection: { instanceId: "opensandbox", model: "default" },
    } as never),
  );

  assert.equal(calls[0]?.threadId, undefined, "nothing is invented for an unknown path");
});
