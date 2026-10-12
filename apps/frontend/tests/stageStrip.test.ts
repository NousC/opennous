// The stage strip's two rules, pinned against a ladder shaped like a real CRM one (invented labels).
//
// Run: node --test apps/frontend/tests/stageStrip.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStageChips, sameStageLabel, stageOrder, type WsStage } from "../src/lib/stageStrip.ts";

// An adopted Sales Pipeline, as workspace_stages holds it (trimmed labels).
const LADDER: WsStage[] = [
  { key: "intro_qualify", label: "Intro / Qualify", canonical: "discovery", sort_order: 0, kind: "active" },
  { key: "trial_started", label: "Trial Started", canonical: "demo", sort_order: 1, kind: "active" },
  { key: "trial_stalled", label: "Trial Stalled", canonical: "demo", sort_order: 2, kind: "active" },
  { key: "trial_finished", label: "Trial Finished", canonical: "demo", sort_order: 3, kind: "active" },
  { key: "approved_verbal", label: "Approved (Verbal)", canonical: "negotiation", sort_order: 4, kind: "active" },
  { key: "contract_out_draft", label: "Contract Out (Draft)", canonical: "negotiation", sort_order: 5, kind: "active" },
  { key: "closed_won", label: "Closed Won", canonical: "closed_won", sort_order: 7, kind: "won" },
  { key: "closed_lost", label: "Closed Lost", canonical: "closed_lost", sort_order: 8, kind: "lost" },
];
const ACTIVE = LADDER.filter(s => s.kind === "active");

const row = (stageLabel: string) => ({ stageLabel, stageColor: "#000" });

test("a leading space does not cost a stage its place", () => {
  // The deal claims carry HubSpot's spelling; the ladder carries the trimmed one.
  const chips = buildStageChips([row(" Intro / Qualify"), row("Trial Started")], ACTIVE, LADDER);
  assert.equal(chips[0].label, "Intro / Qualify");
  assert.equal(chips[1].label, "Trial Started");
});

test("a trailing space does not split one stage into two chips", () => {
  const chips = buildStageChips(
    [row("Contract Out (Draft) "), row("Contract Out (Draft)"), row("Contract Out (Draft) ")],
    ACTIVE, LADDER,
  );
  assert.equal(chips.length, 1);
  assert.equal(chips[0].n, 3);
});

test("the printed label is trimmed", () => {
  const chips = buildStageChips([row(" Intro / Qualify")], ACTIVE, LADDER);
  assert.equal(chips[0].label, "Intro / Qualify");
});

test("Closed Won and Closed Lost come after every in-flight stage, won before lost", () => {
  const chips = buildStageChips(
    [row("Closed Lost"), row("Closed Won"), row("Trial Started"), row(" Intro / Qualify")],
    ACTIVE, LADDER,
  );
  assert.deepEqual(chips.map(c => c.label),
    ["Intro / Qualify", "Trial Started", "Closed Won", "Closed Lost"]);
});

test("a stage the ladder does not name falls to the end, not into the middle", () => {
  // "Inbound/Signup" belongs to the Partner pipeline; it must never outrank an adopted stage.
  const chips = buildStageChips(
    [row("Inbound/Signup"), row("Inbound/Signup"), row("Trial Started")],
    ACTIVE, LADDER,
  );
  assert.equal(chips[0].label, "Trial Started");
  assert.equal(chips[1].label, "Inbound/Signup");
});

test("unranked stages are ordered by size among themselves", () => {
  const chips = buildStageChips(
    [row("On Hold"), row("Researching"), row("Researching")],
    ACTIVE, LADDER,
  );
  assert.deepEqual(chips.map(c => [c.label, c.n]), [["Researching", 2], ["On Hold", 1]]);
});

test("the closers are read from the full ladder, never from the active one", () => {
  // Passing ACTIVE as the full ladder is the bug this guards: no closers, so they rank 1000.
  assert.ok(!stageOrder(ACTIVE, ACTIVE).includes("Closed Won"));
  assert.ok(stageOrder(ACTIVE, LADDER).includes("Closed Won"));
});

test("sameStageLabel ignores case and surrounding whitespace, not inner text", () => {
  assert.ok(sameStageLabel(" Closed Won ", "closed won"));
  assert.ok(!sameStageLabel("Closed Won", "Closed Lost"));
  assert.ok(!sameStageLabel("Trial Started", "TrialStarted"));
});

test("an empty board produces no chips", () => {
  assert.deepEqual(buildStageChips([], ACTIVE, LADDER), []);
});
