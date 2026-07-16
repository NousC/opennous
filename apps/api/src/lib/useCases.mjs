// What is this team actually using AI for?
//
// An op name ("v2.context") is a tool, not a job. Nobody's boss asks how many
// times the context endpoint was called; they ask whether the team is getting
// anything out of it. So every op is classified into a JOB — the thing a person
// was trying to get done.
//
// The taxonomy below is derived from this workspace's real traffic, not imported
// from another product. The web questions people actually type ("brief me on my
// meeting with Vik", "what's gone quiet", "what patterns are across our
// meetings") and the MCP ops agents actually call (workspace reads, lead ops,
// write-backs) are what defined these categories.

export const USE_CASES = {
  meeting_prep:     'Meeting prep',
  account_research: 'Account research',
  follow_up:        'Follow-up & attention',
  pattern_analysis: 'Pattern & pipeline analysis',
  icp_targeting:    'ICP & targeting',
  list_building:    'List building & enrichment',
  recording_intel:  'Recording intel',
  outreach:         'Outreach drafting',
  data_hygiene:     'Data hygiene',
  other:            'Other',
};

export const USE_CASE_KEYS = Object.keys(USE_CASES);

// ─── What counts as usage at all ────────────────────────────────────────────
//
// This is the decision the whole feature rests on, and getting it wrong makes the
// chart worse than useless — it makes it lie.
//
// workspace_system_log records THREE different things that look alike in a table
// and mean nothing alike:
//
//   1. Someone using AI      — an agent in Claude Code, the SDK, or the web chat.
//   2. Data arriving         — a LinkedIn webhook, a Gmail poll, a CRM sync.
//   3. Scripts and bulk jobs — 24,000 curl requests over five days.
//
// Only (1) is usage. (2) is the product working, not a person using it — nobody
// "adopted AI" because a webhook fired. (3) is noise that would have out-weighed
// every real interaction 3-to-1 and buried the actual signal.
//
// So usage means: a human-driven surface, running a real verb.
export const USAGE_SOURCES = new Set([
  'mcp',   // Claude Code and other MCP clients
  'sdk',   // someone's own agent, built on the SDK
  'web',   // the agent in the app
]);

// Pipeline events that happen TO the graph rather than being asked OF it.
const SYSTEM_EVENTS =
  /^(webhook_received|sync_complete|activity_pushed|creation_skipped|scan_complete|enrichment_run|stage_|crm_|v2\.people)/;

/**
 * Is this row somebody actually using AI?
 *
 * Deliberately strict. An op we can't attribute to a person on a human-driven
 * surface is left out of the usage picture entirely — not bucketed as "Other",
 * because "Other" implies it was usage we couldn't name, and this wasn't usage.
 */
export function isAgentUsage(source, eventType) {
  if (!USAGE_SOURCES.has(String(source))) return false;
  return !SYSTEM_EVENTS.test(String(eventType ?? ''));
}

// ─── Agent traffic: the tool says what the job was ───────────────────────────
//
// An agent calling v2.leads is building a list. One calling v2.observations.write
// is recording what happened. No model needed — the verb IS the intent, and
// guessing with an LLM here would be slower, costlier and less accurate.
const OP_USE_CASES = [
  [/^v2\.leads/,                          'list_building'],
  [/^v2\.observations\.write|^v2\.notes/, 'recording_intel'],
  [/^v2\.account\.merge|dedup|^v2\.verify/, 'data_hygiene'],
  [/^v2\.workspace/,                      'icp_targeting'],   // our own ICP / GTM profile
  [/^v2\.context|^v2\.account|^v2\.query/, 'account_research'],
  [/^v2\.attention/,                      'follow_up'],
  [/^v2\.report/,                         'pattern_analysis'],
  [/enrichment/,                          'list_building'],
];

/** Classify one op by its event type. Returns null when we genuinely can't tell. */
export function useCaseForOp(eventType) {
  const t = String(eventType ?? '');
  for (const [re, uc] of OP_USE_CASES) {
    if (re.test(t)) return uc;
  }
  return null;
}

// ─── Web chats: only the language says what the job was ──────────────────────
//
// "Brief me on my meeting with Vik" and "catch me up on Kabir" both hit
// get_account — the tools can't tell them apart, but the person's intent is
// completely different. This is the one place a model earns its cost.

const CLASSIFY_SYSTEM = [
  'You classify what a GTM operator was trying to get done, from the question they asked their agent.',
  '',
  'Return exactly one of these keys, and nothing else:',
  ...Object.entries(USE_CASES).map(([k, label]) => `  ${k} — ${label}`),
  '',
  'Guidance:',
  '  meeting_prep     — preparing for a specific upcoming call ("brief me on tomorrow\'s call", "what should I open with")',
  '  account_research — understanding a person or company ("who is X", "catch me up on Y", "what do we know")',
  '  follow_up        — who has gone quiet, who needs chasing, what needs attention',
  '  pattern_analysis — trends ACROSS accounts ("what patterns are in our meetings", "how is the pipeline")',
  '  icp_targeting    — our own ICP, positioning, who we should target, who fits',
  '  list_building    — sourcing or enriching leads',
  '  recording_intel  — logging what happened, saving a note',
  '  outreach         — drafting a message, email, or follow-up to send',
  '  data_hygiene     — merging duplicates, fixing or verifying records',
  '  other            — none of the above, or too vague to tell',
  '',
  'Answer with the key alone. No punctuation, no explanation.',
].join('\n');

/**
 * Classify a web chat turn. Cheap (Haiku, a few tokens out) and best-effort:
 * a failure returns null rather than a wrong label, because a usage chart built
 * on guesses is worse than one with gaps in it.
 */
export async function classifyChatTurn(anthropic, question, tools = []) {
  const q = String(question ?? '').trim();
  if (q.length < 8) return null;

  try {
    const resp = await anthropic.messages.create({
      feature: 'usage-classify',
      model: 'claude-haiku-4-5',
      max_tokens: 12,
      system: CLASSIFY_SYSTEM,
      messages: [{
        role: 'user',
        content: tools.length
          // The tools it reached for are a strong hint, so give them to the model —
          // but the question is what decides it.
          ? `Question: ${q.slice(0, 500)}\nTools the agent used: ${tools.join(', ')}`
          : `Question: ${q.slice(0, 500)}`,
      }],
    });
    const raw = (resp.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('').trim().toLowerCase();
    const key = raw.replace(/[^a-z_]/g, '');
    return USE_CASE_KEYS.includes(key) ? key : null;
  } catch {
    return null;
  }
}
