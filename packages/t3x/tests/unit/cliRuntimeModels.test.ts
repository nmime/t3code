/**
 * Unit: model slugs reach the agent CLI as a flag.
 *
 * The turn's model is opaque to the worker — it is the model gateway's slug —
 * so the rules pinned here are the whole contract: the "default" sentinel (and
 * an absent model) run the agent's own default, an explicit model becomes the
 * configured flag, `defaultModel` covers agents that need a flag even for the
 * default, and the slug is shell-quoted as one word.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCliCommand } from "../../src/worker/runtimes/CliRuntime.js";

const codex = {
  command: "codex exec --skip-git-repo-check $MODEL_ARG $PROMPT",
  modelFlag: "--model $MODEL",
};
const openclaw = {
  command: "openclaw agent exec --config $CWD/.openclaw/openclaw.json5 $MODEL_ARG $PROMPT",
  modelFlag: "--model omniroute/$MODEL",
  defaultModel: "auto/best-coding",
};

test("the default sentinel runs the agent's own default (no flag)", () => {
  assert.equal(
    buildCliCommand(codex, { cwd: "/w", prompt: "hi", model: "default" }),
    "codex exec --skip-git-repo-check  'hi'",
  );
  assert.equal(
    buildCliCommand(codex, { cwd: "/w", prompt: "hi" }),
    "codex exec --skip-git-repo-check  'hi'",
  );
});

test("an explicit model becomes the configured flag", () => {
  assert.equal(
    buildCliCommand(codex, { cwd: "/w", prompt: "hi", model: "gpt-5.6-sol" }),
    "codex exec --skip-git-repo-check --model 'gpt-5.6-sol' 'hi'",
  );
});

test("defaultModel covers agents that need a flag even for the default", () => {
  assert.equal(
    buildCliCommand(openclaw, { cwd: "/w", prompt: "hi", model: "default" }),
    "openclaw agent exec --config '/w'/.openclaw/openclaw.json5 --model 'omniroute/auto/best-coding' 'hi'",
  );
  assert.equal(
    buildCliCommand(openclaw, { cwd: "/w", prompt: "hi", model: "gpt-6.1-sol" }),
    "openclaw agent exec --config '/w'/.openclaw/openclaw.json5 --model 'omniroute/gpt-6.1-sol' 'hi'",
  );
});

test("a model without modelFlag changes nothing", () => {
  const noFlag = { command: "echo $MODEL_ARG $PROMPT" };
  assert.equal(
    buildCliCommand(noFlag, { cwd: "/w", prompt: "hi", model: "gpt-5.5" }),
    "echo  'hi'",
  );
});

test("a hostile slug stays one shell word", () => {
  const command = buildCliCommand(codex, {
    cwd: "/w",
    prompt: "hi",
    model: "x; rm -rf / #",
  });
  assert.equal(
    command,
    "codex exec --skip-git-repo-check --model 'x; rm -rf / #' 'hi'",
  );
});
