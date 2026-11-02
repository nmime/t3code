/**
 * Unit: what a thread does with the task it already has on the control plane.
 *
 * A terminal task refuses messages, so reusing one wedges the thread with
 * `task_state_invalid: task does not accept messages`; those are replaced.
 * A suspended task is resumed, tasks still coming up are waited for, and a live
 * task is reused as it is. An unknown state is reused rather than silently
 * replaced, so a state added later cannot throw away a live sandbox.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { existingTaskDisposition } from "./adapter.ts";

test("terminal tasks are replaced, never reused", () => {
  assert.equal(existingTaskDisposition("completed"), "replace");
  assert.equal(existingTaskDisposition("failed"), "replace");
});

test("suspended is resumed, coming-up states are waited for", () => {
  assert.equal(existingTaskDisposition("suspended"), "resume");
  for (const state of ["pending", "provisioning", "restoring"]) {
    assert.equal(existingTaskDisposition(state), "wait");
  }
});

test("live tasks are reused", () => {
  for (const state of ["ready", "running", "waiting"]) {
    assert.equal(existingTaskDisposition(state), "reuse");
  }
});

test("an unknown state is reused, not replaced", () => {
  assert.equal(existingTaskDisposition("some-future-state"), "reuse");
});
