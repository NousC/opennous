// The data audit — is this graph actually sound?
//
// The one question a technical buyer asks before trusting a system they didn't
// write: how do I know your data is right? Every GTM tool answers "trust us."
// This answers with a list you can check, and a fix for each line on it.
//
// Two principles run through every check here, and both were learned the hard way:
//
//   NEVER GUESS. A duplicate we are certain of and a duplicate we merely suspect
//   are different objects, and merging the second kind silently corrupts a customer
//   graph in a way that is very hard to undo. Certainty is a tier, not a boolean,
//   and the uncertain tier goes to a human.
//
//   NEVER CRY WOLF. A CSV import that last ran 41 days ago is not broken; it is a
//   CSV import. Only a source with an expected cadence can be late. An audit that
//   flags normal behaviour is one people stop reading, and an audit nobody reads is
//   worse than none — it launders a false sense of safety.

const DAY = 86_400_000;
const PAGE = 1000;   // PostgREST caps any response at 1000 rows regardless of .limit()

// ── Which sources are supposed to keep arriving ─────────────────────────────
//
// CONTINUOUS sources poll or receive webhooks: silence means breakage. BURSTY
// sources fire when a human does something: silence means nobody did it, which is
// not a fault. Getting this distinction wrong is what makes monitoring noise.
// Sources that ARRIVE on their own — a poller or a webhook keeps them coming. If
// one goes quiet, something is broken. Everything else (a CSV import, a manual
// note, a lead list) fires when a human does something, and silence just means
// nobody did it. Flagging those is how a monitor becomes noise you mute.
const CONTINUOUS = {
  gmail:           'Gmail',
  google_calendar: 'Google Calendar',
  cal_com:         'Cal.com',
  linkedin:        'LinkedIn',
  slack:           'Slack',
  fireflies:       'Fireflies',
  hubspot:         'HubSpot',
  salesforce:      'Salesforce',
  attio:           'Attio',
  smtp:            'Email (SMTP)',
};

// How much silence is too much? Learn it, don't hard-code it.
//
// A fixed "7 days = broken" rule is wrong in both directions. Gmail on a busy week
// delivers hourly and on a quiet week not at all — so seven days of silence flags a
// healthy inbox. Meanwhile a CRM that syncs nightly can be dead for six days and a
// 7-day rule says nothing.
//
// So compare each source against ITS OWN rhythm: the typical gap between the things
// it delivers. Silence that is many times a source's normal gap means it stopped.
// Silence that is normal for that source means nothing at all.
const LATE_MULTIPLE = 5;      // silent for 5x its usual gap → it stopped
const MIN_QUIET_DAYS = 3;     // never cry wolf about a source merely quiet today

// And a backstop, for the source we cannot read a rhythm from.
//
// A connector with only two or three deliveries in its life has no baseline, and my
// first instinct — "we cannot judge, so say nothing" — reported HubSpot as HEALTHY
// after 48 days of total silence. That is worse than a false alarm: it is an audit
// actively reassuring you about a dead integration. A continuous source is one that
// is SUPPOSED to keep arriving, so three weeks of nothing is broken whether or not
// we can compute its cadence.
const DEAD_AFTER_DAYS = 21;

/**
 * The typical gap between the DAYS a source delivers on.
 *
 * Measured over active days, never over raw events. Connectors ingest in bursts —
 * a LinkedIn sync writes 200 rows sharing a second — so the median gap between
 * EVENTS is zero, which makes every source look like it should deliver constantly
 * and flags a healthy one after three quiet days. What we actually want to know is:
 * how often does a day go by with something from this source in it?
 */
function medianGapDays(timestamps) {
  const days = [...new Set(timestamps.map(t => Math.floor(t / DAY)))].sort((a, b) => a - b);
  if (days.length < 4) return null;   // too little history to have a rhythm; don't guess
  const gaps = [];
  for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
  gaps.sort((a, b) => a - b);
  return Math.max(1, gaps[Math.floor(gaps.length / 2)]);   // a source delivers at most once a day, by this measure
}

/**
 * The people this audit is actually about.
 *
 * This distinction decides whether the whole feature is credible. The graph holds
 * 4,000+ people, but most are scraped post-engagers — a name harvested from a
 * LinkedIn thread, never intended as someone you would email. Measuring "can you
 * reach them?" against every name ever ingested reports 3% health and is worthless:
 * you were never trying to reach them. They are CONTEXT, not contacts.
 *
 * A contact is someone you have actually engaged with, or deliberately put on a
 * list to engage with. Everyone else is background, and the audit says so instead
 * of counting them as failures.
 */
async function loadPeople(supabase, workspaceId) {
  const entities = await pageAll(supabase, 'entities', 'id, type', workspaceId,
    q => q.eq('type', 'person'));   // companies are not people; do not ask for their email
  const personIds = new Set(entities.map(e => e.id));

  // Engaged means you have actually been in CONTACT — a message, a reply, a meeting,
  // a connection. Not "added to a campaign" (that is a list, and the sending tool
  // holds the address), not "opened an email" or "liked a post" (that is them
  // touching you, and tells us nothing about whether we can reach them back).
  //
  // Getting this line wrong is what made the first run claim 1,188 people were
  // "engaged but unreachable": 2,038 of them had only ever been added to a campaign.
  const CONVERSATION = /^interaction\.(linkedin_message|linkedin_reply|linkedin_connected|email_received|email_sent|email_reply|reply|positive_reply|meeting_held|meeting_scheduled|proposal_sent|deal_)/;

  const interactions = await pageAll(supabase, 'observations', 'entity_id, property', workspaceId,
    q => q.like('property', 'interaction.%'));
  const engaged = new Set(
    interactions
      .filter(o => personIds.has(o.entity_id) && CONVERSATION.test(o.property))
      .map(o => o.entity_id));

  return { personIds, engaged };
}

/**
 * Page through a table properly.
 *
 * TWO traps here, and this codebase has fallen into both.
 *
 * The cap: PostgREST returns at most 1000 rows however many you ask for, silently.
 *
 * The order: a range query with no ORDER BY has no defined order, so successive
 * pages may repeat rows and skip others. That is not a theoretical worry — it made
 * this very audit report Gmail as "8 days silent", then healthy, then "12 days
 * silent" across three consecutive runs of unchanged data. An audit that cannot
 * reproduce its own answer is worth less than no audit, because it teaches people
 * to ignore it. Order by the primary key and the pages become a partition.
 */
async function pageAll(supabase, table, select, workspaceId, tweak) {
  const rows = [];
  for (let from = 0; from < 200_000; from += PAGE) {
    let q = supabase.from(table).select(select).eq('workspace_id', workspaceId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// ── 1. ARRIVING — is the data even coming in? ───────────────────────────────
//
// The most expensive failure in GTM data, because it is invisible: nothing errors,
// the app looks fine, and every answer quietly goes stale. You find out when you
// walk into a meeting believing an account is cold.
async function checkArriving(supabase, workspaceId, now) {
  const rows = await pageAll(supabase, 'observations', 'source, observed_at', workspaceId);

  const times = new Map();
  for (const o of rows) {
    if (!CONTINUOUS[o.source]) continue;
    // Meetings are observed in the FUTURE (a call next Tuesday). They say nothing
    // about whether the connector is alive TODAY, so clamp them to now.
    const t = Math.min(+new Date(o.observed_at), now);
    times.set(o.source, [...(times.get(o.source) ?? []), t]);
  }

  const sources = [];
  const findings = [];
  for (const [key, label] of Object.entries(CONTINUOUS)) {
    const ts = times.get(key);
    if (!ts?.length) continue;                 // never connected — absent, not broken

    const silent = (now - Math.max(...ts)) / DAY;
    const gap = medianGapDays(ts);
    // Late against its own rhythm, OR simply dead — whichever fires first.
    const late = silent > DEAD_AFTER_DAYS
      || (gap !== null && silent > Math.max(MIN_QUIET_DAYS, gap * LATE_MULTIPLE));

    sources.push({
      source: key, label,
      days_silent: Math.floor(silent),
      usual_gap_days: gap === null ? null : Math.round(gap * 10) / 10,
      ok: !late,
    });

    if (late) {
      const rhythm = gap === null
        ? 'There is too little history to know its usual rhythm, but a connector that is meant to keep arriving and has not for three weeks is not merely quiet.'
        : `${label} normally delivers ${gap < 1.5 ? 'about every day' : `about every ${Math.round(gap)} days`} — it has been silent ${Math.round(silent / gap)}x longer than that.`;
      findings.push({
        check: 'arriving',
        severity: 'high',
        title: `${label} has delivered nothing for ${Math.floor(silent)} days`,
        detail: `${rhythm} It stopped, most likely an expired token. This is the most expensive failure in GTM data because it is invisible: nothing errors, the app looks fine, and every answer about these accounts is silently ${Math.floor(silent)} days out of date and does not say so.`,
        // Honest: nobody can re-consent on your behalf. That needs a browser.
        fixable_by: 'human',
        fix: `Reconnect ${label} in Integrations. It needs a browser — no command can re-authorise it for you.`,
        subjects: [{ source: key, days_silent: Math.floor(silent), usual_gap_days: Math.round(gap * 10) / 10 }],
      });
    }
  }

  const live = sources.filter(s => s.ok).length;
  return {
    key: 'arriving',
    label: 'Arriving',
    question: 'Is the data still coming in?',
    pct: sources.length ? Math.round((live / sources.length) * 100) : 100,
    summary: `${live} of ${sources.length} connectors delivering on their usual rhythm`,
    sources,
    findings,
  };
}

// ── 2. RESOLVED — is every person ONE person? ───────────────────────────────
//
// Certainty is a tier, and the tiers get different treatment:
//
//   certain    — two records share an EMAIL or a LINKEDIN URL. That is the same
//                human. Identifiers do not coincide.
//   likely     — same name AND same company. Probably one person, but "John Smith
//                at Acme" is a real collision in a big company. We propose; a human
//                confirms.
//   uncertain  — the name matches and nothing else does. This is where a naive
//                system destroys a graph: your two "Alex" records are two
//                different accounts, and merging them would be unrecoverable in
//                practice. We never merge these. We ask.
async function checkResolved(supabase, workspaceId, people) {
  const claims = await pageAll(
    supabase, 'claims', 'entity_id, property, value', workspaceId,
    q => q.in('property', ['name', 'first_name', 'last_name', 'email', 'linkedin_url', 'company', 'company_name']),
  );

  const ent = new Map();
  for (const c of claims) {
    if (!people.personIds.has(c.entity_id)) continue;   // two companies sharing a name is not a duplicate person
    const e = ent.get(c.entity_id) ?? {};
    e[c.property] = c.value;
    ent.set(c.entity_id, e);
  }

  const fullName = (e) =>
    norm(e.name) || norm([e.first_name, e.last_name].filter(Boolean).join(' '));

  // Group by every identifier that could indicate the same human.
  const byEmail = new Map(), byLinkedIn = new Map(), byName = new Map();
  const add = (m, k, id) => { if (k) m.set(k, [...(m.get(k) ?? []), id]); };

  for (const [id, e] of ent) {
    add(byEmail, norm(e.email), id);
    // Strip the trailing slash and query so two spellings of one profile collide.
    add(byLinkedIn, norm(e.linkedin_url).replace(/\/+$/, '').split('?')[0], id);
    add(byName, fullName(e), id);
  }

  const pairs = new Map();   // "a|b" → { ids, confidence, why }
  const record = (ids, confidence, why) => {
    const sorted = [...new Set(ids)].sort();
    if (sorted.length < 2) return;
    const key = sorted.join('|');
    const rank = { certain: 3, likely: 2, uncertain: 1 };
    const existing = pairs.get(key);
    // A pair can qualify twice. Keep the strongest reason — shared email beats
    // "same name", and the strongest evidence is what decides whether we may act.
    if (!existing || rank[confidence] > rank[existing.confidence]) {
      pairs.set(key, { ids: sorted, confidence, why });
    }
  };

  for (const [email, ids] of byEmail) if (ids.length > 1) record(ids, 'certain', `both have the email ${email}`);
  for (const [url, ids] of byLinkedIn) if (ids.length > 1) record(ids, 'certain', `both have the LinkedIn profile ${url}`);

  for (const [name, ids] of byName) {
    if (ids.length < 2 || !name) continue;
    const companies = ids.map(id => norm(ent.get(id)?.company ?? ent.get(id)?.company_name));
    const known = companies.filter(Boolean);
    // Same name, same company → likely. Same name, different companies → they are
    // probably two different people who happen to share a name, so say nothing.
    if (known.length >= 2 && new Set(known).size === 1) {
      record(ids, 'likely', `same name, both at ${known[0]}`);
    } else if (new Set(known).size <= 1) {
      record(ids, 'uncertain', `same name (${name}), and nothing else in common to confirm it`);
    }
  }

  const dupes = [...pairs.values()];
  const certain   = dupes.filter(d => d.confidence === 'certain');
  const likely    = dupes.filter(d => d.confidence === 'likely');

  // A name colliding between two people you have NEVER engaged is import noise —
  // two scraped strangers who happen to share a name. There are hundreds, none of
  // them matter, and surfacing them would bury the five that do. An uncertain
  // duplicate is only worth your attention when you are actually working one of
  // the two people.
  const allUncertain = dupes.filter(d => d.confidence === 'uncertain');
  const uncertain = allUncertain.filter(d => d.ids.some(id => people.engaged.has(id)));
  const noise = allUncertain.length - uncertain.length;

  // Name them, so a finding is a list of people and not a list of UUIDs.
  const nameOf = (id) => fullName(ent.get(id) ?? {}) || id.slice(0, 8);
  const subject = (d) => ({
    entity_ids: d.ids,
    who: d.ids.map(nameOf),
    confidence: d.confidence,
    why: d.why,
  });

  const findings = [];
  if (certain.length) {
    findings.push({
      check: 'resolved', severity: 'high',
      title: `${certain.length} ${certain.length === 1 ? 'person exists' : 'people exist'} twice, and we can prove it`,
      detail: 'These records share an email address or a LinkedIn profile, so they are the same human — identifiers do not coincide. Until they are merged, half of what you know about this person is invisible to the other half: "have we spoken to them?" answers no while the conversation sits on the other record.',
      fixable_by: 'agent',
      fix: 'Merge them. The merge is lossless and reversible: the duplicate\'s email and LinkedIn re-attach to the survivor, so a future match on either resolves to one account.',
      subjects: certain.map(subject),
    });
  }
  if (likely.length) {
    findings.push({
      check: 'resolved', severity: 'medium',
      title: `${likely.length} probable ${likely.length === 1 ? 'duplicate' : 'duplicates'} — same name, same company`,
      detail: 'Almost certainly one person, but two people with the same name at the same company is a real thing, so this is a proposal rather than a fact.',
      fixable_by: 'agent_with_confirmation',
      fix: 'Review each pair and merge the ones that are genuinely the same person.',
      subjects: likely.map(subject),
    });
  }
  if (uncertain.length) {
    findings.push({
      check: 'resolved', severity: 'low',
      title: `${uncertain.length} ${uncertain.length === 1 ? 'name that appears' : 'names that appear'} on more than one record`,
      detail: 'The names match and nothing else does — no shared email, no shared LinkedIn, no shared company. These may be one person we have failed to link, or two different people who happen to share a name. We will not guess: merging two different humans is not something you can cleanly undo, and it is exactly how a customer graph gets quietly poisoned.',
      fixable_by: 'human',
      fix: 'Look at them and tell the agent which, if any, are the same person.',
      subjects: uncertain.map(subject),
    });
  }

  // Score against the people you actually work. A scraped stranger sharing a name
  // with another scraped stranger does not make your pipeline wrong.
  const engagedCount = [...ent.keys()].filter(id => people.engaged.has(id)).length || ent.size;
  const affected = new Set(
    [...certain, ...likely, ...uncertain].flatMap(d => d.ids).filter(id => people.engaged.has(id))).size;

  return {
    key: 'resolved',
    label: 'Resolved',
    question: 'Is every person one record?',
    pct: engagedCount ? Math.round(((engagedCount - affected) / engagedCount) * 100) : 100,
    summary: `${certain.length} certain, ${likely.length} probable, ${uncertain.length} unclear`,
    note: noise
      ? `${noise.toLocaleString()} more names collide between people you have never engaged (scraped lists). Import noise, not counted.`
      : undefined,
    findings,
  };
}

// ── 3. EVIDENCED — does every fact trace back to something that happened? ───
//
// The distinction the whole substrate rests on: an OBSERVATION is something that
// happened and we saw it. A CLAIM with nothing behind it is an assertion someone
// imported. Both look like knowledge in a CRM. Only one of them is.
async function checkEvidenced(supabase, workspaceId) {
  const claims = await pageAll(
    supabase, 'claims', 'entity_id, property, supporting_observation_ids', workspaceId,
  );
  if (!claims.length) {
    return { key: 'evidenced', label: 'Evidenced', question: 'Does every fact trace to a source?', pct: 100, summary: 'No facts yet', findings: [] };
  }

  const unsupported = claims.filter(c => !(c.supporting_observation_ids?.length));
  const byProperty = {};
  for (const c of unsupported) byProperty[c.property] = (byProperty[c.property] ?? 0) + 1;
  const worst = Object.entries(byProperty).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const findings = [];
  const pct = Math.round(((claims.length - unsupported.length) / claims.length) * 100);

  if (unsupported.length) {
    findings.push({
      check: 'evidenced',
      severity: pct < 80 ? 'medium' : 'low',
      title: `${unsupported.length.toLocaleString()} facts have nothing behind them`,
      detail: 'These claims cite no observation — nobody said them, no system reported them, they arrived through an import and nothing has confirmed them since. They are assertions, not evidence, and an agent that cannot tell the difference will state an imported job title with the same confidence as something the person said on a call last week. You cannot manufacture the evidence that was never captured; what you can do is stop trusting these blindly and verify the ones you are about to act on.',
      fixable_by: 'agent',
      fix: 'Verify the ones that matter — the emails you are about to send to, the titles you are about to personalise on. `verify` re-checks a claim against current observations.',
      subjects: worst.map(([property, count]) => ({ property, count })),
    });
  }

  return {
    key: 'evidenced',
    label: 'Evidenced',
    question: 'Does every fact trace to a source?',
    pct,
    summary: `${pct}% of ${claims.length.toLocaleString()} facts trace to something that happened`,
    findings,
  };
}

// ── 4. CURRENT — is it still true? ──────────────────────────────────────────
async function checkCurrent(supabase, workspaceId) {
  const claims = await pageAll(supabase, 'claims', 'entity_id, property, freshness', workspaceId,
    q => q.is('invalid_at', null));
  if (!claims.length) {
    return { key: 'current', label: 'Current', question: 'Is it still true?', pct: 100, summary: 'No facts yet', findings: [] };
  }

  // Only the facts you ACT on can hurt you by being stale. A decayed "industry" is
  // a shrug; a decayed email address is a bounce, and a decayed pipeline stage is a
  // forecast built on a lie.
  const ACTIONABLE = ['email', 'pipeline_stage', 'job_title', 'company'];
  const stale = claims.filter(c =>
    (c.freshness === 'suspect' || c.freshness === 'expired') &&
    (ACTIONABLE.includes(c.property) || String(c.property).startsWith('deal.')));

  const pct = Math.round(((claims.length - stale.length) / claims.length) * 100);
  const byProperty = {};
  for (const c of stale) byProperty[c.property] = (byProperty[c.property] ?? 0) + 1;

  const findings = stale.length ? [{
    check: 'current',
    severity: stale.some(c => c.property === 'email') ? 'medium' : 'low',
    title: `${stale.length} facts you act on have gone stale`,
    detail: 'These are past the point where we still vouch for them. A stale email bounces, a stale pipeline stage puts a dead deal in your forecast.',
    fixable_by: 'agent',
    fix: 'Re-verify them against current observations. Anything that cannot be confirmed gets retired rather than quietly believed.',
    subjects: Object.entries(byProperty).map(([property, count]) => ({ property, count })),
  }] : [];

  return {
    key: 'current',
    label: 'Current',
    question: 'Is it still true?',
    pct,
    summary: stale.length ? `${stale.length} actionable facts past their freshness` : 'Everything actionable is current',
    findings,
  };
}

// ── 5. REACHABLE — can you actually contact these people? ───────────────────
//
// The check nobody writes, and the one that silently wastes a campaign. A LinkedIn
// member-URN URL (/in/ACoAA…) is LinkedIn's internal id: the API accepts it, the
// send "succeeds", and the message goes precisely nowhere.
async function checkReachable(supabase, workspaceId, people) {
  const claims = await pageAll(supabase, 'claims', 'entity_id, property, value', workspaceId,
    q => q.in('property', ['email', 'linkedin_url', 'channels', 'name', 'first_name', 'last_name']));

  const ent = new Map();
  for (const c of claims) {
    if (!people.personIds.has(c.entity_id)) continue;   // companies do not have inboxes
    const e = ent.get(c.entity_id) ?? {};
    e[c.property] = c.value;
    ent.set(c.entity_id, e);
  }

  // Only the people you are actually working. Scraped names are context.
  const contacts = [...ent.entries()].filter(([id]) => people.engaged.has(id));
  const background = ent.size - contacts.length;

  if (!contacts.length) {
    return {
      key: 'reachable', label: 'Reachable', question: 'Can you reach the people you are working?',
      pct: 100, summary: 'Nobody engaged yet', findings: [],
    };
  }

  const deadHandles = [];
  const unreachable = [];
  for (const [id, e] of contacts) {
    const url = String(e.linkedin_url ?? '');
    const memberUrn = /\/in\/ACoAA/i.test(url);
    const who = norm(e.name) || [e.first_name, e.last_name].filter(Boolean).join(' ') || id.slice(0, 8);

    // An OPEN CONVERSATION is a way to reach someone. If you have a LinkedIn thread
    // with them you can simply reply in it — you never needed their profile URL.
    // Counting those people as "unreachable" is how this check first claimed 192
    // people were uncontactable when you were literally mid-conversation with them.
    const hasOpenChat = !!e.channels?.linkedin?.chat_id;

    // A member-URN handle is only a PROBLEM if it is the only way you have. With an
    // open thread or an email, nothing is broken.
    if (memberUrn && !hasOpenChat && !norm(e.email)) {
      deadHandles.push({ entity_id: id, who, linkedin_url: url });
    }
    if (!norm(e.email) && !hasOpenChat && !(url && !memberUrn)) {
      unreachable.push({ entity_id: id, who });
    }
  }

  const pct = Math.round(((contacts.length - unreachable.length) / contacts.length) * 100);

  const findings = [];
  if (deadHandles.length) {
    findings.push({
      check: 'reachable', severity: 'medium',
      title: `${deadHandles.length} LinkedIn handles that cannot receive a message`,
      detail: "These are member-URN URLs (/in/ACoAA…) — LinkedIn's internal id, not a public handle. The send API accepts them and reports success, and the message arrives nowhere. A campaign to these people looks like it worked.",
      fixable_by: 'agent',
      fix: 'Re-enrich them to recover the real profile URL, or mark them unreachable so nothing pretends to send to them.',
      subjects: deadHandles.slice(0, 50),
    });
  }
  if (unreachable.length) {
    findings.push({
      check: 'reachable', severity: 'medium',
      title: `${unreachable.length} people you are working but cannot contact`,
      detail: 'You have interacted with these people, and the record holds no email and no usable LinkedIn handle. Any list they land in is quietly short by that many.',
      fixable_by: 'agent',
      fix: 'Enrich them to recover a way to reach them.',
      subjects: unreachable.slice(0, 50),
    });
  }

  return {
    key: 'reachable',
    label: 'Reachable',
    question: 'Can you reach the people you are working?',
    pct,
    summary: `${pct}% of ${contacts.length} engaged contacts have a working way to reach them`,
    // Say what we deliberately did not count, so the number is auditable — this is
    // an audit; it cannot itself be a black box.
    note: background
      ? `${background.toLocaleString()} other people on record have never been engaged (scraped names, imported lists). They are context, not contacts, and are not counted here.`
      : undefined,
    findings,
  };
}

/**
 * Run the whole audit.
 *
 * Every check returns the same shape: a percentage (how healthy), a summary (what
 * that means), and findings (what is wrong, and who can fix it).
 */
export async function runAudit(supabase, workspaceId, { now = Date.now() } = {}) {
  // Who counts as a person, and who counts as someone you are actually working.
  // Every check below leans on this, and getting it wrong is what made the first
  // run report 3% health by counting scraped strangers and companies as contacts
  // you had failed to email.
  const people = await loadPeople(supabase, workspaceId);

  const [arriving, resolved, evidenced, current, reachable] = await Promise.all([
    checkArriving(supabase, workspaceId, now),
    checkResolved(supabase, workspaceId, people),
    checkEvidenced(supabase, workspaceId),
    checkCurrent(supabase, workspaceId),
    checkReachable(supabase, workspaceId, people),
  ]);

  const checks = [arriving, resolved, evidenced, current, reachable];
  const findings = checks.flatMap(c => c.findings);
  const rank = { high: 3, medium: 2, low: 1 };
  findings.sort((a, b) => rank[b.severity] - rank[a.severity]);

  return {
    checked_at: new Date(now).toISOString(),
    checks: checks.map(({ findings: _f, ...rest }) => rest),
    findings,
    failing: findings.length,
    // The one number, and it is deliberately the WORST check rather than an average.
    // Averaging a dead Gmail connector against 98% freshness produces a comfortable
    // number and a false sense of safety. A chain is as strong as its weakest link.
    health: Math.min(...checks.map(c => c.pct)),
  };
}
