/**
 * The command template an agent runtime is configured with, and the one thing
 * that has to hold for every runtime: the prompt and the working directory
 * arrive as *one shell word*, whatever they contain.
 *
 * This is not theoretical. `substituteCommand` used to always single-quote, so
 * a template that quoted its own placeholder — `--config "$CWD/file"` — produced
 * `--config "'/workspace/project'/file"`: OpenClaw answered `--config file not
 * found: /workspace/project/'/workspace/project'/.openclaw/openclaw.json5`, and
 * every codex prompt arrived wrapped in literal single quotes. The test runs the
 * substituted command through a real shell, because that is where the bug lived.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

import { substituteCommand } from "../../src/worker/runtimes/CliRuntime.js";

const CWD = "/workspace/project";

const run = (command: string): string => {
  const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

/** Substitute both placeholders as the worker does. */
const expand = (template: string, prompt: string): string =>
  substituteCommand(substituteCommand(template, "$CWD", CWD), "$PROMPT", prompt);

/** What bash sees as argument `n` (1-based) of the expanded command. */
const argument = (template: string, prompt: string, n: number): string =>
  run(`set -- ${expand(template, prompt)}; printf '%s' "$${n}"`);

const HOSTILE = [
  "plain",
  "with spaces",
  "with 'single quotes'",
  'with "double quotes"',
  "with $HOME and $(whoami) and `id`",
  "with a backslash \\ and a semicolon; echo nope",
  "with a newline\nand a tab\tinside",
  "",
];

test("a bare placeholder becomes one word, whatever it contains", () => {
  for (const prompt of HOSTILE) {
    assert.equal(argument("agent run $PROMPT", prompt, 3), prompt);
  }
});

test("a quoted placeholder becomes one word too", () => {
  for (const prompt of HOSTILE) {
    assert.equal(argument('agent run "$PROMPT"', prompt, 3), prompt);
  }
});

test("a path built from $CWD stays a path", () => {
  // The shape that broke: a path assembled from $CWD inside double quotes.
  const expanded = expand('openclaw agent exec --config "$CWD/.openclaw/openclaw.json5" hi', "hi");
  assert.ok(
    !expanded.includes(`"${CWD}"`) && !expanded.includes(`'${CWD}'`),
    `no quotes inside the path: ${expanded}`,
  );
  assert.equal(
    argument('agent --config "$CWD/.openclaw/openclaw.json5" $PROMPT', "hi", 3),
    `${CWD}/.openclaw/openclaw.json5`,
  );
  assert.equal(
    argument("agent --config $CWD/.openclaw/openclaw.json5 $PROMPT", "hi", 3),
    `${CWD}/.openclaw/openclaw.json5`,
  );
});

test("a working directory with a space is still one word", () => {
  const spaced = substituteCommand("agent --cwd $CWD $PROMPT", "$CWD", "/srv/my project");
  assert.equal(run(`set -- ${spaced}; printf '%s' "$3"`), "/srv/my project");
});

test("the built-in templates put the prompt in the last argument", () => {
  // The exact templates the worker registers, with the agent's argv captured by
  // a shell function that prints each argument on its own line.
  const templates = [
    "codex exec --skip-git-repo-check $PROMPT",
    "claude -p --dangerously-skip-permissions $PROMPT",
    "opencode run $PROMPT",
    "pi --prompt $PROMPT",
    "openclaw agent exec --config $CWD/.openclaw/openclaw.json5 --model omniroute/auto/best-coding $PROMPT",
  ];
  for (const template of templates) {
    const prompt = 'do the thing; it\'s "mine" — and $HOME';
    const expanded = expand(template, prompt);
    const withPrintf = expanded.replace(/^\S+/, "printf '%s\\n'");
    const lines = run(withPrintf).split("\n");
    lines.pop(); // printf ends with a newline
    assert.equal(lines[lines.length - 1], prompt, template);
  }
});
