// When does a routine run next?
//
// All the fiddly bits of "every Monday at 07:00" live here, alone, because
// wall-clock scheduling is where this kind of feature quietly rots. Two rules:
//
//   1. The user picks a WALL-CLOCK time in THEIR zone. "07:00 Monday" means 07:00
//      as their kitchen clock reads it — in Berlin that is 05:00 UTC in summer and
//      06:00 UTC in winter. Storing a UTC offset once and reusing it means the
//      briefing drifts by an hour twice a year, which is exactly the sort of bug
//      that makes people stop trusting a scheduler.
//   2. Everything is computed FORWARD from now. We never trust a stored next_run_at
//      to still be correct after a code change, a DST shift, or an edit.
//
// No date library: Intl gives us zone-aware parts, and that is all we need.

/** What the wall clock in `timeZone` reads at instant `date`. */
function partsInZone(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
    weekday: 'short',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour % 24, minute: +p.minute,
    dow: DOW[p.weekday] ?? 0,
  };
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads the given local time.
 *
 * There's no direct API for this, so we guess, look at what the clock in that zone
 * ACTUALLY reads at our guess, and correct by however far that is from the time we
 * wanted. Twice — the first correction can itself cross a DST boundary, and the
 * second settles it.
 *
 * The subtlety that bites: the thing to drive to zero is the gap between the local
 * time we SEE and the local time we WANT — not the gap between local and UTC, which
 * is just the zone's offset and is never zero anywhere but Greenwich. Comparing
 * against UTC applies the offset a second time and fires the routine two hours early
 * in Berlin, which is precisely the bug this file exists to prevent.
 */
function zonedTimeToUtc(target, timeZone) {
  const wanted = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, 0);
  let utc = wanted;
  for (let i = 0; i < 2; i++) {
    const seen = partsInZone(new Date(utc), timeZone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0);
    const drift = seenAsUtc - wanted;   // how far the local clock overshoots what we asked for
    if (drift === 0) break;
    utc -= drift;
  }
  return new Date(utc);
}

const QUARTER_MONTHS = [1, 4, 7, 10];   // Jan, Apr, Jul, Oct

/**
 * The next instant this routine should fire, strictly after `from`.
 *
 * Returns a Date, or null if the routine isn't a clock routine.
 */
export function nextRunAt(routine, from = new Date()) {
  if (routine.trigger_kind !== 'clock') return null;

  const tz = routine.timezone || 'UTC';
  const [h, m] = String(routine.at_time || '09:00').split(':').map(Number);
  const hour = Number.isFinite(h) ? h : 9;
  const minute = Number.isFinite(m) ? m : 0;

  const now = partsInZone(from, tz);

  // Candidate: the target time today, in their zone. If that's already gone,
  // start looking from tomorrow.
  const candidate = (dayOffset) => {
    const base = new Date(Date.UTC(now.year, now.month - 1, now.day + dayOffset));
    const p = partsInZone(base, 'UTC');   // pure date arithmetic, no zone shifting
    return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour, minute }, tz);
  };

  switch (routine.frequency) {
    case 'daily': {
      const today = candidate(0);
      return today > from ? today : candidate(1);
    }

    case 'weekly': {
      const want = routine.day_of_week ?? 1;   // default Monday
      // Days until the next occurrence of that weekday. 0 means today — which only
      // counts if the time hasn't passed yet, otherwise it's a week out.
      let delta = (want - now.dow + 7) % 7;
      if (delta === 0 && candidate(0) <= from) delta = 7;
      return candidate(delta);
    }

    case 'monthly': {
      const want = routine.day_of_month ?? 1;
      // This month if the day hasn't passed, else next month.
      let year = now.year, month = now.month;
      const thisMonth = zonedTimeToUtc({ year, month, day: want, hour, minute }, tz);
      if (thisMonth > from) return thisMonth;
      month += 1;
      if (month > 12) { month = 1; year += 1; }
      return zonedTimeToUtc({ year, month, day: want, hour, minute }, tz);
    }

    case 'quarterly': {
      const want = routine.day_of_month ?? 1;
      for (let i = 0; i < 5; i++) {
        // Walk the quarter starts, this year and next, and take the first that's
        // still ahead of us.
        const year = now.year + Math.floor(i / 4);
        const month = QUARTER_MONTHS[i % 4];
        const at = zonedTimeToUtc({ year, month, day: want, hour, minute }, tz);
        if (at > from) return at;
      }
      return null;
    }

    default:
      return null;
  }
}

/** Human summary of the trigger — the one line the Tasks list shows. */
export function describeTrigger(r) {
  if (r.trigger_kind === 'before_meeting') {
    const mins = r.offset_minutes ?? 60;
    if (mins % 10080 === 0) return `${mins / 10080}w before each meeting`;
    if (mins % 1440 === 0)  return `${mins / 1440}d before each meeting`;
    if (mins % 60 === 0)    return `${mins / 60}h before each meeting`;
    return `${mins}m before each meeting`;
  }

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const at = String(r.at_time ?? '').slice(0, 5);
  switch (r.frequency) {
    case 'daily':     return `Every day at ${at}`;
    case 'weekly':    return `Every ${DAYS[r.day_of_week ?? 1]} at ${at}`;
    case 'monthly':   return `Day ${r.day_of_month ?? 1} of each month at ${at}`;
    case 'quarterly': return `Day ${r.day_of_month ?? 1} of each quarter at ${at}`;
    default:          return 'Not scheduled';
  }
}
