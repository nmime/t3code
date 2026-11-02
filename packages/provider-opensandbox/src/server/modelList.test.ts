/**
 * Unit: the instance's `models` setting becomes the picker's model list.
 *
 * Slugs are opaque labels the worker hands to the agent CLI, so the parsing
 * rules are the contract: `slug` or `slug=Display name`, commas or newlines,
 * duplicates and the "default" sentinel dropped, empty input stays empty.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseModelList } from "./driver.ts";

test("empty or absent input stays empty", () => {
  assert.deepEqual(parseModelList(undefined), []);
  assert.deepEqual(parseModelList(""), []);
  assert.deepEqual(parseModelList("  , \n ,"), []);
});

test("slugs and slug=name entries, comma or newline separated", () => {
  assert.deepEqual(
    parseModelList("auto/best-coding, gpt-5.6-sol=GPT-5.6 Sol\ngpt-6.1-sol"),
    [
      { slug: "auto/best-coding", name: "auto/best-coding", isCustom: false, isDefault: false, capabilities: null },
      { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, isDefault: false, capabilities: null },
      { slug: "gpt-6.1-sol", name: "gpt-6.1-sol", isCustom: false, isDefault: false, capabilities: null },
    ],
  );
});

test("duplicates and the default sentinel are dropped", () => {
  const parsed = parseModelList("default, a, a, b");
  assert.deepEqual(parsed.map((m) => m.slug), ["a", "b"]);
});
