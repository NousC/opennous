// The signal pickers offer only connected recorders and sources (GET-892).
//
// Run: node --test apps/frontend/tests/signalOptions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { meetingSignalOptions, signalSourceChoices, MEETING_ANY_LABEL, SIGNAL_SOURCES } from "../src/lib/signalOptions.ts";

const meeting = (providers: string[]) => ({ key: "meeting.done", label: "Meeting done", providers });

test("one option per connected recorder, then any recorder", () => {
  assert.deepEqual(meetingSignalOptions(meeting(["granola", "fireflies", "any"])), [
    { key: "meeting.done:granola", label: "Meeting done · Granola" },
    { key: "meeting.done:fireflies", label: "Meeting done · Fireflies" },
    { key: "meeting.done", label: MEETING_ANY_LABEL },
  ]);
});

test("no recorder connected: no meeting options (the picker shows the connect hint)", () => {
  assert.deepEqual(meetingSignalOptions(meeting([])), []);
  assert.deepEqual(meetingSignalOptions(meeting(["any"])), []);
  assert.deepEqual(meetingSignalOptions(null), []);
});

test("sources: only connected ones, plus any the signal already reads; all when the server does not say", () => {
  assert.deepEqual(signalSourceChoices(["slack", "granola", "linear"]), ["granola", "slack"]);
  assert.deepEqual(signalSourceChoices(["slack"], ["fathom"]), ["fathom", "slack"]);
  assert.deepEqual(signalSourceChoices(undefined), SIGNAL_SOURCES);
  assert.deepEqual(signalSourceChoices([]), []);
});
