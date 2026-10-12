import type { SupabaseClient } from '@supabase/supabase-js';
import {
  listBoardItems, listInsightTags, listInsightRows, listTopicStates, saveTopicState, companyNames,
  loadInternalSpeakers, isInternalSpeaker, boardTaxonomy, loadBusinessType, type TopicState,
} from '../db/insightBoard.js';
import { companyDomains } from '../db/documents.js';
import { recordObservations, type ObservationInput } from '../db/observations.js';
import {
  claimLinearIssueLink, linkLinearIssue, finishLinearIssueLink, releaseLinearIssueClaim,
} from '../db/linearIssueLinks.js';
import { isFreeEmailDomain } from '../utils/identity.js';

// Send an Insights topic to Linear (GET-825).
//
// One Linear issue per topic: the board row (subtype × tag) is the thing a product team acts on,
// not a single insight. The issue carries the topic's title, its quotes and the accounts that
// raised it, a link back to the topic, and a Linear customer request per insight, so Linear can
// count who asked. Sending again never files a second issue: the link table remembers the issue,
// and the link-back attachment finds it even when the row is gone (attachment URLs are unique per
// issue in Linear). Only insights Linear has not seen are added.
//
// What leaves us: names, domains, quotes and who said them. Never deal amounts, revenue or ICP
// tier (decided 2026-10-09: everyone with Linear access would see them).
//
// Every send is mirrored back into the graph: the link row, the topic moving from New to Aware,
// and one `product.linear_issue` event on each account behind the topic. Linear is never the only
// place a fact lives.
//
// Linear is reached through `gql`, a GraphQL caller the API builds from the workspace's
// connection (apps/api/src/providers/linear.mjs), so this file holds no tokens.

export type LinearGql = (query: string, variables?: Record<string, unknown>) => Promise<any>;

export interface LinearIssueRef { id: string; identifier: string; url: string }

export interface SendTopicResult {
  created: boolean;
  issue: LinearIssueRef;
  requests_added: number;
  requests_skipped: null | 'customers_unavailable';
  accounts: number;
}

/** Most insights one send turns into customer requests. The rest go on the next send. */
export const LINEAR_MAX_REQUESTS_PER_SEND = 100;
/** Most quotes written into the issue description. */
const MAX_QUOTES = 8;

const LINEAR_PRIORITY: Record<string, number> = { urgent: 1, high: 2, medium: 3, low: 4 };

/** Topic priority → Linear's (0 none, 1 urgent, 2 high, 3 medium, 4 low). */
export function linearPriority(p: string | null | undefined): number {
  return (p && LINEAR_PRIORITY[p]) || 0;
}

/**
 * The topic page in the app. Also the link-back attachment's URL, which is how a send finds an
 * issue it filed before, so it must be stable. It names the workspace: untagged topics share a key
 * ('bug|none') across workspaces, and two workspaces connected to one Linear must not find each
 * other's issues.
 */
export function topicUrl(appUrl: string, workspaceId: string, topicKey: string): string {
  return `${String(appUrl || '').replace(/\/+$/, '')}/insights/${encodeURIComponent(topicKey)}?ws=${encodeURIComponent(workspaceId)}`;
}

function day(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const oneLine = (s: string | null | undefined, max = 280) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

interface IssueItem { statement: string; quote: string | null; speaker: string | null; company: string | null; occurred_at: string | null }

/** IssueCreateInput for a topic. Pure, for the tests. */
export function buildLinearIssueInput(t: {
  teamId: string; url: string; subtypeLabel: string; title: string | null; headline: string | null;
  priority: string | null; items: IssueItem[];
}): { teamId: string; title: string; description: string; priority: number } {
  const name = t.title || t.headline || 'Customer insight';
  const accounts = [...new Set(t.items.map((i) => i.company).filter(Boolean))] as string[];
  const lines: string[] = [];
  if (t.headline && t.headline !== name) lines.push(t.headline, '');
  lines.push(`Raised by ${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}${accounts.length ? `: ${accounts.slice(0, 12).join(', ')}${accounts.length > 12 ? ', …' : ''}` : ''}.`, '');
  const quoted = t.items.slice(0, MAX_QUOTES);
  if (quoted.length) {
    lines.push('**What they said**', '');
    for (const i of quoted) {
      const who = [i.speaker, i.company].filter(Boolean).join(', ');
      const when = day(i.occurred_at);
      const prov = [who, when].filter(Boolean).join(' · ');
      lines.push(`> ${oneLine(i.quote || i.statement)}`, `> — ${prov || 'customer'}`, '');
    }
    if (t.items.length > quoted.length) lines.push(`…and ${t.items.length - quoted.length} more in OpenNous.`, '');
  }
  lines.push(`[Open the topic in OpenNous](${t.url})`);
  return { teamId: t.teamId, title: `${t.subtypeLabel}: ${oneLine(name, 200)}`, description: lines.join('\n'), priority: linearPriority(t.priority) };
}

/** The body of one Linear customer request: the insight, its quote, who said it and when. */
export function linearCustomerNeedBody(i: { statement: string; quote: string | null; speaker: string | null; occurred_at: string | null }): string {
  const prov = [i.speaker, day(i.occurred_at)].filter(Boolean).join(', ');
  const quote = i.quote ? `\n\n> ${oneLine(i.quote)}` : '';
  return `${oneLine(i.statement, 500)}${quote}${prov ? `\n\n— ${prov}` : ''}`;
}

// ── Linear GraphQL ──────────────────────────────────────────────────────────

const Q_ATTACHMENTS_FOR_URL = `query AttachmentsForUrl($url: String!) {
  attachmentsForURL(url: $url) { nodes { issue { id identifier url } } }
}`;
const M_ISSUE_CREATE = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;
const M_ATTACHMENT_CREATE = `mutation AttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success }
}`;
const M_CUSTOMER_UPSERT = `mutation CustomerUpsert($input: CustomerUpsertInput!) {
  customerUpsert(input: $input) { success customer { id } }
}`;
const M_CUSTOMER_NEED_CREATE = `mutation CustomerNeedCreate($input: CustomerNeedCreateInput!) {
  customerNeedCreate(input: $input) { success need { id } }
}`;

// ── The topic ───────────────────────────────────────────────────────────────

interface TopicItem { id: string; statement: string; quote: string | null; speaker: string | null; occurred_at: string | null; company_id: string }

/**
 * One topic exactly as the board shows it: placed external insights under this subtype and main
 * tag, said by a customer (never one of our own people), on an account we can name. Null when the
 * topic has none.
 */
export async function loadLinearTopic(
  supabase: SupabaseClient, workspaceId: string, topicKey: string, visibleCompanyIds: Set<string> | null = null,
) {
  const [subtype, tagId] = String(topicKey).split('|');
  if (!subtype || !tagId) return null;
  const [items, tags, rows, internal, states, bt] = await Promise.all([
    listBoardItems(supabase, workspaceId), listInsightTags(supabase, workspaceId),
    listInsightRows(supabase, workspaceId).catch(() => []), loadInternalSpeakers(supabase, workspaceId),
    listTopicStates(supabase, workspaceId).catch(() => [] as TopicState[]), loadBusinessType(supabase, workspaceId).catch(() => 'software' as const),
  ]);
  const mine = items.filter((i) => i.subtype === subtype && (i.tag_ids?.[0] ?? 'none') === tagId
    && i.company_id && !isInternalSpeaker(i, internal)
    // A member who may only see some accounts sends only those (per-member visibility).
    && (!visibleCompanyIds || visibleCompanyIds.has(i.company_id)));
  if (!mine.length) return null;
  const ids = [...new Set(mine.map((i) => i.company_id as string))];
  const [names, domains] = await Promise.all([companyNames(supabase, workspaceId, ids), companyDomains(supabase, workspaceId, ids)]);
  const named = mine.filter((i) => names.has(i.company_id as string))
    .sort((a, b) => String(b.occurred_at ?? '').localeCompare(String(a.occurred_at ?? '')));
  if (!named.length) return null;
  const subtypeLabel = boardTaxonomy(bt).subtypes.find((s) => s.key === subtype)?.label ?? subtype;
  return {
    key: topicKey,
    subtypeLabel,
    title: tagId === 'none' ? null : tags.find((t) => t.id === tagId)?.name ?? null,
    headline: rows.find((r) => r.subtype === subtype && r.tag_id === tagId)?.headline ?? null,
    state: states.find((s) => s.topic_key === topicKey) ?? null,
    items: named.map((i) => ({ id: i.id, statement: i.statement, quote: i.quote, speaker: i.speaker, occurred_at: i.occurred_at, company_id: i.company_id as string })) as TopicItem[],
    companies: [...new Set(named.map((i) => i.company_id as string))].map((id) => ({ id, name: names.get(id) as string, domain: domains.get(id) ?? null })),
  };
}

// ── The send ────────────────────────────────────────────────────────────────

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Linear errors that mean customer requests are off or out of reach, not a one-off failure. */
const customersOff = (e: unknown) => /customer|not enabled|feature|permission|scope|forbidden/i.test(String((e as Error)?.message ?? ''));

export async function sendTopicToLinear(supabase: SupabaseClient, opts: {
  workspaceId: string; topicKey: string; teamId: string; gql: LinearGql; appUrl: string; userId?: string | null;
  /** Restricted member: only these accounts' insights leave. Null = every account. */
  visibleCompanyIds?: Set<string> | null;
}): Promise<SendTopicResult> {
  const { workspaceId, topicKey, teamId, gql, appUrl } = opts;
  const topic = await loadLinearTopic(supabase, workspaceId, topicKey, opts.visibleCompanyIds ?? null);
  if (!topic) fail('topic_not_found', 'No customer insights under this topic.');
  const url = topicUrl(appUrl, workspaceId, topicKey);
  const companyName = new Map(topic.companies.map((c) => [c.id, c.name]));

  // 0. Claim the topic, so two sends at once cannot both file an issue.
  const link = await claimLinearIssueLink(supabase, workspaceId, topicKey);
  if (!link) fail('send_in_progress', 'This topic is being sent to Linear right now. Try again in a moment.');

  // 1. The issue: the one we filed before, else one already carrying our link, else a new one.
  //    Linked the moment it exists, so a failure after this point can never file a second one.
  let issue: LinearIssueRef | null = link.status === 'linked' && link.linear_issue_id
    ? { id: link.linear_issue_id, identifier: link.identifier as string, url: link.url as string } : null;
  let created = false;
  if (!issue) {
    try {
      const found = await gql(Q_ATTACHMENTS_FOR_URL, { url });
      issue = found?.attachmentsForURL?.nodes?.find((n: any) => n?.issue)?.issue ?? null;
      if (!issue) {
        const input = buildLinearIssueInput({
          teamId, url, subtypeLabel: topic.subtypeLabel, title: topic.title, headline: topic.headline,
          priority: topic.state?.priority ?? null,
          items: topic.items.map((i) => ({ ...i, company: companyName.get(i.company_id) ?? null })),
        });
        const res = await gql(M_ISSUE_CREATE, { input });
        if (!res?.issueCreate?.success || !res.issueCreate.issue) fail('linear_issue_failed', 'Linear did not create the issue.');
        issue = res.issueCreate.issue as LinearIssueRef;
        created = true;
      }
      await linkLinearIssue(supabase, workspaceId, topicKey, issue, link.team_id ?? teamId);
    } catch (e) {
      if (!issue) await releaseLinearIssueClaim(supabase, workspaceId, topicKey).catch(() => {});
      throw e;
    }
  }

  // 2. The link back and the customer requests. Whatever was filed is recorded in `finally`, so a
  //    retry after a failure here never files the same request twice.
  const sent = new Set(link.sent_item_ids ?? []);
  const added: string[] = [];
  let skipped: SendTopicResult['requests_skipped'] = null;
  try {
    // Idempotent per (issue, url) in Linear, so re-sending only refreshes it.
    await gql(M_ATTACHMENT_CREATE, { input: {
      issueId: issue.id, url, title: `OpenNous · ${topic.title || topic.headline || topic.subtypeLabel}`,
      subtitle: `${topic.companies.length} ${topic.companies.length === 1 ? 'account' : 'accounts'}`,
    } });

    const fresh = topic.items.filter((i) => !sent.has(i.id)).slice(0, LINEAR_MAX_REQUESTS_PER_SEND);
    const customerOf = new Map<string, string | null>();
    for (const it of fresh) {
      if (!customerOf.has(it.company_id)) {
        const c = topic.companies.find((x) => x.id === it.company_id);
        const domain = c?.domain && !isFreeEmailDomain(c.domain) ? c.domain : null;
        let id: string | null = null;
        if (domain) {
          try {
            // Domain and our id only. Linear matches the customer by domain; sending our name would
            // rename one the team already keeps there, and nothing about the deal goes (2026-10-09).
            const res = await gql(M_CUSTOMER_UPSERT, { input: { domains: [domain], externalId: it.company_id } });
            id = res?.customerUpsert?.customer?.id ?? null;
          } catch (e) {
            // This one company only (a domain conflict, a bad domain): its requests land without a customer.
            console.warn('[linear] customer upsert skipped:', (e as Error)?.message || e);
          }
        }
        customerOf.set(it.company_id, id);
      }
      const input: Record<string, unknown> = { issueId: issue.id, body: linearCustomerNeedBody(it) };
      const customerId = customerOf.get(it.company_id);
      if (customerId) input.customerId = customerId;
      try {
        const res = await gql(M_CUSTOMER_NEED_CREATE, { input });
        if (res?.customerNeedCreate?.success) added.push(it.id);
      } catch (e) {
        // Customer Requests off in this Linear workspace, or Linear failing: stop here. The issue
        // already carries the quotes; what was filed is kept, the rest goes on the next send.
        console.warn('[linear] customer request failed:', (e as Error)?.message || e);
        if (customersOff(e)) skipped = 'customers_unavailable';
        else if (!added.length) throw e;
        break;
      }
    }
  } finally {
    await finishLinearIssueLink(supabase, workspaceId, topicKey, [...sent, ...added], opts.userId ?? null);
  }

  // 3. Mirror back into the graph.
  const now = new Date().toISOString();
  if ((topic.state?.status ?? 'new') === 'new') {
    await saveTopicState(supabase, workspaceId, topicKey, { status: 'aware' }, opts.userId ?? null);
  }
  const events: ObservationInput[] = topic.companies.map((c) => ({
    workspaceId, entityId: c.id, kind: 'event', property: 'product.linear_issue',
    value: {
      action: created ? 'issue_created' : 'requests_added', identifier: issue!.identifier, url: issue!.url,
      topic_key: topicKey, topic: topic.title || topic.headline, requests: topic.items.filter((i) => i.company_id === c.id && added.includes(i.id)).length,
    },
    source: 'linear', method: 'api', observedAt: now,
    // One event per account per issue: a later send that adds nothing for this account is not news.
    externalId: `${issue!.id}:${c.id}:sent`,
    sourceRef: issue!.url,
  }));
  await recordObservations(supabase, events).catch((e) => console.warn('[linear] mirror to graph failed:', e?.message || e));

  return { created, issue, requests_added: added.length, requests_skipped: skipped, accounts: topic.companies.length };
}
