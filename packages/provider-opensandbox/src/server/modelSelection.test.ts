import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveModelSelection } from "./modelSelection.ts";

test("a thread's own choice wins over the instance default", () => {
  assert.equal(resolveModelSelection("codex/gpt-6.1-sol", "auto/best-coding"), "codex/gpt-6.1-sol");
});

test("the default sentinel becomes the instance's default model", () => {
  assert.equal(resolveModelSelection("default", "codex/gpt-6.1-sol"), "codex/gpt-6.1-sol");
});

test("without an instance default the sentinel stays a sentinel", () => {
  assert.equal(resolveModelSelection("default", undefined), "default");
  assert.equal(resolveModelSelection("default", "   "), "default");
  assert.equal(resolveModelSelection(undefined, undefined), "default");
});

test("an empty selection with an instance default uses it", () => {
  assert.equal(resolveModelSelection(null, "codex/gpt-6.1-sol"), "codex/gpt-6.1-sol");
});
