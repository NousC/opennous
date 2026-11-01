// A blank page, not a wrong link: see src/config/contact.ts. The registry must not be read at load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the contact link is read at render, never while modules load", () => {
  const src = readFileSync(new URL("../src/config/contact.ts", import.meta.url), "utf8");
  assert.match(src, /export const contactUrl = \(\): string =>/);
  assert.doesNotMatch(src, /^export const \w+(: \w+)? = cloud\./m);
});
