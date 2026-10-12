// The one format for money, numbers, times and dates (GET-595), pinned.
//
// Run: node --test apps/frontend/tests/format.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { day, due, inDays, isOverdue, money, num, signed, time, toDate, when } from "../src/lib/format.ts";

// Friday 2 October 2026, 21:30 local.
const NOW = new Date(2026, 9, 2, 21, 30);
const at = (d: number, h = 12, m = 0, month = 9, y = 2026) => new Date(y, month, d, h, m);

test("money: whole units in tables, short in stats", () => {
  assert.equal(money(186000), "$186,000");
  assert.equal(money(1421500), "$1,421,500");
  assert.equal(money(null), "—");
  assert.equal(money(9800, "stat"), "$9,800");
  assert.equal(money(94500, "stat"), "$94.5k");
  assert.equal(money(462000, "stat"), "$462k");
  assert.equal(money(1420000, "stat"), "$1.42M");
  assert.equal(money(2000000, "stat"), "$2M");
  assert.equal(money(-6900), "−$6,900");
});

test("num and signed", () => {
  assert.equal(num(5200), "5,200");
  assert.equal(num(undefined), "—");
  assert.equal(signed(1), "+1");
  assert.equal(signed(-2), "−2");
  assert.equal(signed(0), "0");
  assert.equal(signed(3.14, { percent: true }), "+3.1%");
});

test("time is 24-hour", () => {
  assert.equal(time(at(2, 14, 30)), "14:30");
  assert.equal(time(at(2, 9, 5)), "09:05");
});

test("a bare YYYY-MM-DD is that calendar day locally", () => {
  const d = toDate("2026-10-14")!;
  assert.equal(d.getDate(), 14);
  assert.equal(d.getMonth(), 9);
});

test("when: relative inside 7 days, then the date", () => {
  assert.equal(when(new Date(NOW.getTime() - 20_000), NOW), "just now");
  assert.equal(when(new Date(NOW.getTime() - 12 * 60_000), NOW), "12m ago");
  assert.equal(when(at(2, 18, 30), NOW), "3h ago");
  assert.equal(when(at(1, 23, 0), NOW), "Yesterday");
  assert.equal(when(at(28, 9, 0, 8), NOW), "4 days ago");
  assert.equal(when(at(24, 9, 0, 8), NOW), "24 Sep");
  assert.equal(when(at(3, 9, 0, 11, 2025), NOW), "3 Dec 2025");
});

test("due: today, tomorrow, weekday, date", () => {
  assert.equal(due("2026-10-02", NOW), "Today");
  assert.equal(due("2026-10-03", NOW), "Tomorrow");
  assert.equal(due("2026-10-01", NOW), "Yesterday");
  assert.equal(due("2026-10-08", NOW), "Thu");
  assert.equal(due("2026-10-14", NOW), "14 Oct");
  assert.equal(due(null, NOW), "No date");
  assert.equal(isOverdue("2026-09-29", NOW), true);
  assert.equal(isOverdue("2026-10-02", NOW), false);
});

test("day and inDays", () => {
  assert.equal(day("2026-10-14", NOW), "14 Oct");
  assert.equal(inDays("2026-10-14", NOW), "in 12 days");
  assert.equal(inDays("2026-10-03", NOW), "in 1 day");
  assert.equal(inDays("2026-09-29", NOW), "3 days ago");
  assert.equal(inDays("2026-10-02", NOW), "today");
});
