// What a job card's rows say (GET-884): Starts, Uses and Delivers, read from the proposal's real steps,
// the server's `facts` (checked channel names, recipients, hosts, table names) and the box's
// destinations. The sentence above them is the server's (`brief`, core jobBrief); nothing here uses
// the model's own words (summary, display titles). Pure, so tests/jobCard.test.ts can pin it.
import type { Delivery, JobProposal, ProposalFact } from '@/lib/revboxes';

/** One Delivers line. `tool` picks its mark; `external` = data leaves the workspace (named in full). */
export type CardTarget = { key: string; tool: string; text: string; external: boolean; writes?: boolean; problem?: boolean };

export const SLACK_LAYOUTS: Record<string, string> = { report: 'Report', approval: 'Approval', alert: 'Alert', handoff: 'Handoff', digest: 'Digest', notification: 'Notification', plain: 'Plain' };
const PROVIDERS = new Set(['granola', 'fireflies', 'fathom']);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const list = (...vs: unknown[]) => vs.flatMap(v => Array.isArray(v) ? v.map(String) : str(v).split(/[,;]/)).map(x => x.trim()).filter(Boolean);
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const recipients = (v: string | undefined | null) => String(v ?? '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
const layoutText = (format: unknown) => (typeof format === 'string' && SLACK_LAYOUTS[format] ? `${SLACK_LAYOUTS[format]} layout` : '');
const join = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' · ');
/** A recipient as a person reads it: a {{template}} is who it means at run time. */
const who = (a: string) => !/\{\{/.test(a) ? a : /attendee|person\.|people/i.test(a) ? 'the people on the call' : /owner/i.test(a) ? 'the owner' : /contact/i.test(a) ? 'the contact' : 'the right person';
const people = (xs: string[]) => [...new Set(xs.map(who))].join(', ');

/** "Every day 08:00 (Toronto)": the server's Starts label, else the trigger's own label shortened. */
export function jobStarts(p: JobProposal): string {
  if (p.brief?.starts) return p.brief.starts;
  const t = p.trigger;
  return t.kind === 'clock' ? t.label.replace(/\bat (\d)/, '$1') : t.label;
}

/** The tools the job touches, in order: its recorder, its steps' tools, the box's destinations. */
export function jobUses(p: JobProposal, destinations: Delivery[] = []): string[] {
  const out: string[] = [];
  const add = (t: string) => { if (t && !out.includes(t)) out.push(t); };
  const cfg = (p.trigger?.config ?? {}) as Record<string, unknown>;
  const triggers = [{ kind: p.trigger?.kind, config: cfg }, ...(Array.isArray(cfg.also) ? cfg.also as { kind?: string; config?: Record<string, unknown> }[] : [])];
  for (const t of triggers) {
    const c = t?.config ?? {};
    for (const x of [str(c.provider), ...(Array.isArray(c.tools) ? c.tools.map(String) : [])]) if (PROVIDERS.has(x)) add(x);
    if (t?.kind === 'hubspot_field_changed') add('hubspot');
  }
  for (const s of p.steps ?? []) {
    if (['hubspot', 'slack', 'gmail', 'email', 'webhook'].includes(s.type)) add(s.type);
  }
  if (p.uses_box_delivery) for (const d of destinations) add(d.kind);
  return out;
}

/**
 * The Slack layout the box's Slack destinations get from this job, as the engine decides it (core
 * boxSlackFormat, GET-872): an older destination's own layout, else the one the agent chose, else
 * the job's own Slack step's, else a report for a schedule and a notification for an event.
 */
export function boxDeliveryLayout(p: JobProposal, destinations: Delivery[]): string | null {
  const slack = destinations.filter(d => d.kind === 'slack');
  if (!slack.length) return null;
  const usable = (v: unknown) => typeof v === 'string' && v !== 'approval' && SLACK_LAYOUTS[v] ? v : null;
  const own = (p.steps ?? []).find(s => s.type === 'slack' && usable(s.config?.format));
  const key = usable(slack.find(d => usable(d.format))?.format) ?? usable(p.box_delivery_format) ?? usable(own?.config?.format) ?? (p.trigger.kind === 'clock' ? 'report' : 'notification');
  return `${SLACK_LAYOUTS[key]} layout`;
}

/** One step's delivery target, or null when the step delivers nothing (reads, AI, conditions). */
function stepTarget(s: JobProposal['steps'][number], f: ProposalFact | undefined): CardTarget | null {
  const c = s.config ?? {};
  const base = { key: s.id, tool: s.type, external: false };
  switch (s.type) {
    case 'slack': {
      if ((f?.action ?? c.action) === 'dm') {
        const name = f?.user ?? (str(c.user_id) || 'Slack user');
        return { ...base, text: join(`${name} in Slack`, layoutText(c.format)) };
      }
      // Only a channel the server found in Slack is named; else its id, flagged.
      const found = f ? f.channel ?? null : null;
      const id = f?.channel_id ?? str(c.channel_id);
      return { ...base, text: join(found ? `#${found}` : `Slack channel ${id || '(none)'}`, layoutText(c.format)), problem: !!f && !found };
    }
    case 'gmail': case 'email': {
      const to = f ? (f.recipients ?? f.sends_to ?? []) : list(c.to, c.cc, c.bcc);
      const draft = s.type === 'gmail' && (f?.mode ?? c.mode) === 'draft';
      const mailbox = s.type === 'gmail' ? (f?.mailbox ?? (str((c.send_from as { email?: unknown } | undefined)?.email) || null)) : null;
      const head = draft ? 'Gmail draft' : s.type === 'gmail' ? 'Email from Gmail' : 'Email';
      return { ...base, external: true, text: join(head, to.length ? `to ${people(to)}` : 'no recipient yet', mailbox && `from ${mailbox}`) };
    }
    case 'webhook': return { ...base, external: true, text: `Webhook to ${f?.host ?? (hostOf(f?.url ?? str(c.url)) || 'no URL')}` };
    case 'dataset_append': {
      const name = f?.dataset ?? (f?.dataset_key ?? (str(c.dataset_key) || 'a table'));
      return { ...base, text: `A row in ${name}${f?.new_dataset ? ' (new table)' : ''}` };
    }
    case 'hubspot': {
      const action = f?.action ?? (str(c.action) || 'note');
      if (action === 'read') return null;
      const text = action === 'note' ? 'A note in HubSpot' : action === 'task' ? (c.task_from === 'call' ? 'Tasks in HubSpot' : 'A task in HubSpot') : `The ${action.replace(/^update_/, '')} in HubSpot`;
      return { ...base, text, writes: true };
    }
    default: return null;
  }
}

/** One box destination as a Delivers line: "#cs-handoffs · Report layout", "Email to a@x". */
function boxTarget(d: Delivery, layout: string | null): CardTarget {
  const base = { key: `box:${d.id}`, tool: d.kind };
  if (d.kind === 'slack') return { ...base, external: false, text: join(d.channel ? `#${d.channel.replace(/^#/, '')}` : d.target || 'Slack channel', layout) };
  if (d.kind === 'email') return { ...base, external: true, text: join('Email', `to ${recipients(d.to ?? d.target).join(', ') || 'no one yet'}`, recipients(d.cc).length && `cc ${recipients(d.cc).join(', ')}`) };
  if (d.kind === 'gmail') return { ...base, external: true, text: join('Gmail draft', recipients(d.to).length && `to ${recipients(d.to).join(', ')}`, d.mailbox_email && `from ${d.mailbox_email}`) };
  return { ...base, external: true, text: `Webhook to ${hostOf(d.target) || 'no URL'}` };
}

/**
 * Every place the job's output goes: its own delivery steps, then the box's destinations when it
 * delivers there. Empty = it stays in the app (the card says "In the app").
 */
export function jobDelivers(p: JobProposal, destinations: Delivery[] = []): CardTarget[] {
  const facts = new Map((p.facts ?? []).map(f => [f.step_id, f] as const));
  const out = (p.steps ?? []).filter(s => s.type !== 'revbox_delivery').map(s => stepTarget(s, facts.get(s.id))).filter((x): x is CardTarget => !!x);
  if (p.uses_box_delivery) {
    const layout = boxDeliveryLayout(p, destinations);
    if (destinations.length) out.push(...destinations.map(d => boxTarget(d, d.kind === 'slack' ? layout : null)));
    else out.push({ key: 'box:none', tool: 'revbox_delivery', external: false, text: 'This box’s destinations (none yet)' });
  }
  return out;
}

/** "Asks you before sending": the job has an approval step. */
export const asksFirst = (p: JobProposal) => p.brief?.asks_first ?? (p.steps ?? []).some(s => s.type === 'approval');

/**
 * The card's one meta line (GET-889): when it starts · the tools it touches → where it delivers, and
 * "asks first" when an approval step holds it. `targets` keep their full text (what leaves the
 * workspace is never cut short) without the Slack layout; none = it stays in the app.
 */
export type CardMeta = { starts: string; tools: string[]; targets: CardTarget[]; asksFirst: boolean };
export function jobMeta(p: JobProposal, destinations: Delivery[] = []): CardMeta {
  const targets = jobDelivers(p, destinations).map(t => ({ ...t, text: t.text.replace(/ · [A-Z][a-z]+ layout$/, '') }));
  return { starts: jobStarts(p), tools: jobUses(p, destinations), targets, asksFirst: asksFirst(p) };
}

const TOOL_LABEL: Record<string, string> = { hubspot: 'HubSpot', slack: 'Slack', gmail: 'Gmail', email: 'Email', webhook: 'Webhook', granola: 'Granola', fireflies: 'Fireflies', fathom: 'Fathom' };
/** The meta line as words (its accessible name): "Every day 08:00 · HubSpot, Slack → #ops-daily · asks first". */
export function jobMetaText(m: CardMeta): string {
  const tools = m.tools.map(t => TOOL_LABEL[t] ?? t.charAt(0).toUpperCase() + t.slice(1)).join(', ');
  const to = m.targets.length ? m.targets.map(t => t.text + (t.writes ? ' (writes)' : '')).join(', ') : 'In the app';
  return join(m.starts, tools ? `${tools} → ${to}` : to, m.asksFirst && 'asks first');
}
