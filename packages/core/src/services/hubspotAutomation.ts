// The HubSpot step of a canvas automation (GET-708): write back to the CRM what the automation
// decided. Four actions, each configured on the step:
//
//   note            a note on the deal, the company and the people, with your body (or what the
//                   AI step wrote)
//   task            a task with your title and body, due in N days, on the same records
//   update_deal     set the fields you chose on the deal: the one that fired it, else the
//   update_contact  account's open deal; the person the run is about; the account's company
//   update_company
//
// Kept apart from crmWriteback.ts on purpose. That file writes follow-up cards and is guarded to
// tasks and notes only; this one writes what a person configured an automation to write, with its
// own short allowlist below. A create is sent once (a blind retry could double it in the customer's
// CRM); an update is idempotent.

import type { SupabaseClient } from '@supabase/supabase-js';
import { hubspotToken } from './hubspotVars.mjs';
import { HUBSPOT_NOTE_ASSOC, HUBSPOT_TASK_ASSOC, hubspotAssociationsFor, escapeHtml, type HubspotTargets } from './crmWriteback.js';

const HS = 'https://api.hubapi.com';
const DAY = 86_400_000;

const ALLOWED: Array<[string, RegExp]> = [
  ['POST', /^\/crm\/v3\/objects\/(notes|tasks)$/],
  ['PATCH', /^\/crm\/v3\/objects\/(deals|contacts|companies)\/\d+$/],
];
/** Only notes and tasks are created, and only deals, contacts and companies are updated. */
export function isAutomationHubspotWrite(method: string, path: string): boolean {
  return ALLOWED.some(([m, re]) => m === method.toUpperCase() && re.test(path));
}

export interface HubspotStepInput {
  action: 'note' | 'task' | 'update_deal' | 'update_contact' | 'update_company' | string;
  title?: string | null;
  body?: string | null;
  dueDays?: number | null;
  /** Already filled: { name: HubSpot internal property name, value }. */
  properties?: { name: string; value: string }[];
  accountEntityId?: string | null;
  dealEntityId?: string | null;
  /** The people the run is about, by email (a call's attendees) and by entity (a signal's person). */
  personEmails?: string[];
  personEntityIds?: string[];
}
export type HubspotStepResult = { ok: true; did: string } | { ok: false; reason: string };

async function send(token: string, method: 'POST' | 'PATCH', path: string, body: unknown): Promise<Response> {
  if (!isAutomationHubspotWrite(method, path)) throw new Error(`hubspotAutomation: refusing ${method} ${path}`);
  return fetch(`${HS}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function why(res: Response): Promise<string> {
  const t = await res.text().catch(() => '');
  try { return String(JSON.parse(t)?.message ?? t).slice(0, 200); } catch { return t.slice(0, 200); }
}

/** The HubSpot ids for the records this run is about. Read only. */
export async function automationHubspotTargets(supabase: SupabaseClient, workspaceId: string, input: HubspotStepInput): Promise<HubspotTargets> {
  const sb = supabase as any;
  const ident = async (kind: string, ids: string[]) => {
    if (!ids.length) return [] as string[];
    const { data } = await sb.from('entity_identifiers').select('value')
      .eq('workspace_id', workspaceId).eq('kind', kind).eq('status', 'active').in('entity_id', ids);
    return [...new Set(((data ?? []) as { value: string }[]).map(r => String(r.value)).filter(Boolean))];
  };
  // The deal: the one that fired it, else the account's most recently active open deal.
  const openDeal = async () => {
    if (!input.accountEntityId) return null;
    const { data } = await sb.from('entity_list_rows').select('entity_id, status, last_activity_at')
      .eq('workspace_id', workspaceId).eq('kind', 'deal').eq('company_id', input.accountEntityId)
      .order('last_activity_at', { ascending: false, nullsFirst: false }).limit(20);
    return ((data ?? []) as { entity_id: string; status: string }[]).find(d => /^open$/i.test(String(d.status)))?.entity_id ?? null;
  };
  const emails = [...new Set((input.personEmails ?? []).map(e => String(e).trim().toLowerCase()).filter(e => e.includes('@')))].slice(0, 10);
  let personIds: string[] = [];
  if (emails.length) {
    const { data } = await sb.from('entity_identifiers').select('entity_id')
      .eq('workspace_id', workspaceId).eq('kind', 'email').eq('status', 'active').in('value', emails);
    personIds = [...new Set(((data ?? []) as { entity_id: string }[]).map(r => r.entity_id))];
  }
  personIds = [...new Set([...personIds, ...(input.personEntityIds ?? []).filter(Boolean)])];
  let dealIds = input.dealEntityId ? await ident('deal_hubspot', [input.dealEntityId]) : [];
  if (!dealIds.length) { const d = await openDeal(); if (d) dealIds = await ident('deal_hubspot', [d]); }
  const [companyIds, contactIds] = await Promise.all([
    ident('hubspot_company', input.accountEntityId ? [input.accountEntityId] : []),
    ident('hubspot', personIds),
  ]);
  return { dealIds, companyId: companyIds[0] ?? null, contactIds };
}

/** Run one HubSpot step. Never throws: a failure comes back as a reason the run records. */
export async function runHubspotStep(supabase: SupabaseClient, workspaceId: string, input: HubspotStepInput, { now = Date.now() } = {}): Promise<HubspotStepResult> {
  const token = await hubspotToken(supabase, workspaceId).catch(() => null);
  if (!token) return { ok: false, reason: 'hubspot_not_connected' };
  const t = await automationHubspotTargets(supabase, workspaceId, input);
  const props = Object.fromEntries((input.properties ?? []).filter(p => p?.name && String(p.value ?? '').trim() !== '')
    .map(p => [p.name, String(p.value).trim()]));
  try {
    if (input.action === 'note' || input.action === 'task') {
      if (!t.dealIds.length && !t.companyId && !t.contactIds.length) return { ok: false, reason: 'hubspot_no_record' };
      const isTask = input.action === 'task';
      const body = String(input.body ?? '').trim();
      const properties: Record<string, string> = isTask
        ? {
            hs_task_subject: String(input.title ?? '').trim() || 'Follow up',
            hs_task_body: body, hs_task_status: 'NOT_STARTED', hs_task_type: 'TODO',
            hs_timestamp: new Date(now + Math.max(0, Number(input.dueDays ?? 1)) * DAY).toISOString(),
          }
        : { hs_note_body: escapeHtml(body).replace(/\n/g, '<br>'), hs_timestamp: new Date(now).toISOString() };
      const res = await send(token, 'POST', `/crm/v3/objects/${isTask ? 'tasks' : 'notes'}`, {
        properties, associations: hubspotAssociationsFor(isTask ? HUBSPOT_TASK_ASSOC : HUBSPOT_NOTE_ASSOC, t),
      });
      if (!res.ok) return { ok: false, reason: `hubspot_${res.status}: ${await why(res)}` };
      return { ok: true, did: `hubspot_${input.action}` };
    }
    const TARGETS: Record<string, [string, string, string | null | undefined]> = {
      update_deal: ['deals', 'deal', t.dealIds[0]],
      update_contact: ['contacts', 'contact', t.contactIds[0]],
      update_company: ['companies', 'company', t.companyId],
    };
    const target = TARGETS[input.action];
    if (!target) return { ok: false, reason: `hubspot_unknown_action:${input.action}` };
    if (!target[2]) return { ok: false, reason: `hubspot_no_${target[1]}` };
    if (!Object.keys(props).length) return { ok: false, reason: 'hubspot_no_fields' };
    const res = await send(token, 'PATCH', `/crm/v3/objects/${target[0]}/${target[2]}`, { properties: props });
    if (!res.ok) return { ok: false, reason: `hubspot_${res.status}: ${await why(res)}` };
    return { ok: true, did: `hubspot_${input.action}:${Object.keys(props).join(',')}` };
  } catch (err: any) {
    return { ok: false, reason: `hubspot_failed: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}
