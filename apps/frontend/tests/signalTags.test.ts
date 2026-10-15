// A signal's tag (GET-894): every tone the server can send has a tinted pill here, and a row from an
// older API (kind and title only) still reads as a label, never snake_case.
//
// Run: node --test apps/frontend/tests/signalTags.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNAL_TONE_CLASS, signalTag } from "../src/lib/signalTags.ts";
// Core's plain .mjs module, read here only to keep the two palettes in step.
import { SIGNAL_TONES, SIGNAL_TONE } from "../../../packages/core/src/services/signalTone.mjs";

test("every tone core assigns has a pill, light and dark", () => {
  for (const tone of SIGNAL_TONES as string[]) {
    const cls = (SIGNAL_TONE_CLASS as Record<string, string>)[tone];
    assert.ok(cls, `no pill for ${tone}`);
    assert.match(cls, /bg-\S+\/10/);
    assert.match(cls, /dark:text-/);
  }
  assert.deepEqual(Object.keys(SIGNAL_TONE_CLASS).sort(), [...(SIGNAL_TONES as string[])].sort());
  for (const tone of Object.values(SIGNAL_TONE as Record<string, string>)) assert.ok(tone in SIGNAL_TONE_CLASS);
});

test("the cell reads label, tone and text from the API", () => {
  const t = signalTag({ kind: "churn_risk", title: null, label: "Churn risk", tone: "red", text: "Switching to a cheaper vendor after renewal." });
  assert.equal(t.label, "Churn risk");
  assert.equal(t.tone, "red");
  assert.match(t.className, /red/);
  assert.equal(t.text, "Switching to a cheaper vendor after renewal.");
  assert.equal(t.tooltip, "Churn risk · Switching to a cheaper vendor after renewal.");
});

test("an older row or an unknown tone degrades quietly", () => {
  const t = signalTag({ kind: "stakeholder_identified", title: "CEO Signs Contract" });
  assert.equal(t.label, "Stakeholder identified");
  assert.equal(t.tone, "slate");
  assert.equal(t.text, "CEO Signs Contract");
  const u = signalTag({ kind: "x", label: "Custom thing", tone: "chartreuse", text: null });
  assert.equal(u.tone, "slate");
  assert.equal(u.tooltip, "Custom thing");
});
