import type { SupabaseClient } from '@supabase/supabase-js';
import { isUUID, isEmail, normaliseLinkedInUrl, VALID_PIPELINE_STAGES } from '../utils/identity.js';
import { computeLinkedInChannel } from '../utils/linkedin.js';
import { listNotes } from './notes.js';
import { listActivities } from './activities.js';
import { fetchEntityOverlays, applyContactOverlay } from './entities.js';
import type {
  Contact, ContactProfile, ContactListItem,
  ListContactsParams, CreateContactParams, UpdateContactParams,
  MemoryCategory,
} from '../types.js';

const CONTACT_SELECT = 'id, email, first_name, last_name, company, job_title, linkedin_url, photo_url, channels, pipeline_stage, deal_health_score, icp_score, icp_fit, last_activity_at, company_id, memory_summary';
const CONTACT_LIST_SELECT = 'id, email, first_name, last_name, company, job_title, source, icp_fit, icp_score, icp_reasoning, deal_health_score, pipeline_stage, last_activity_at, deal_stage, company_id, linkedin_url, channels, photo_url';

function formatContact(c: Record<string, unknown>): ContactListItem {
  return {
    id: c.id as string,
    email: c.email as string,
    name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
    company: (c.company as string) || null,
    company_id: (c.company_id as string) || null,
    title: (c.job_title as string) || null,
    linkedin_url: (c.linkedin_url as string) || null,
    channels: c.channels
      ? { ...(c.channels as Record<string, unknown>), ...((c.channels as Record<string, unknown>).linkedin ? { linkedin: computeLinkedInChannel((c.channels as Record<string, Record<string, unknown>>).linkedin) } : {}) }
      : null,
    icp_fit: (c.icp_fit as string) ?? null,
    icp_score: (c.icp_score as number) ?? null,
    deal_health_score: (c.deal_health_score as number) ?? null,
    pipeline_stage: ((c.pipeline_stage as string) || 'identified') as Contact['pipeline_stage'],
    last_activity_at: (c.last_activity_at as string) || null,
  };
}

export async function listContacts(
  supabase: SupabaseClient,
  workspaceId: string,
  params: ListContactsParams = {},
): Promise<{ contacts: ContactListItem[]; total: number; limit: number; offset: number }> {
  const { search, pipeline_stage, company_id, ids, filter, sort = 'recent', linkedin_url } = params;
  const limitNum = Math.min(params.limit ?? 50, 200);
  const offsetNum = params.offset ?? 0;

  let query = supabase
    .from('contacts')
    .select(CONTACT_LIST_SELECT, { count: 'exact' })
    .eq('workspace_id', workspaceId);

  if (ids?.trim()) {
    const idList = ids.split(',').map(s => s.trim()).filter(Boolean);
    if (idList.length) query = query.in('id', idList);
  }

  if (sort === 'score' || sort === 'deal_health_score' || sort === 'connection_score') {
    query = query.order('deal_health_score', { ascending: false, nullsFirst: false });
  } else if (sort === 'urgency') {
    // Urgency = high-ICP contacts that have gone cold (or were never touched) rank first.
    // ICP score DESC, then oldest/never-touched first within the same ICP tier.
    query = query
      .order('icp_score', { ascending: false, nullsFirst: false })
      .order('last_activity_at', { ascending: true, nullsFirst: true });
  } else {
    query = query.order('last_activity_at', { ascending: false, nullsFirst: false });
  }

  if (search?.trim()) {
    const q = `%${search.trim()}%`;
    // Build OR clauses — also split multi-word queries so "John Smith" matches first_name+last_name
    const parts = search.trim().split(/\s+/).filter(Boolean);
    let orClauses = `email.ilike.${q},first_name.ilike.${q},last_name.ilike.${q},company.ilike.${q}`;
    if (parts.length > 1) {
      for (const part of parts) {
        const pq = `%${part}%`;
        orClauses += `,first_name.ilike.${pq},last_name.ilike.${pq}`;
      }
    }
    query = query.or(orClauses);
  }

  if (linkedin_url?.trim()) {
    const norm = normaliseLinkedInUrl(linkedin_url.trim());
    if (norm) query = query.eq('linkedin_url', norm);
  }

  if (pipeline_stage && (VALID_PIPELINE_STAGES as readonly string[]).includes(pipeline_stage)) {
    query = query.eq('pipeline_stage', pipeline_stage);
  }

  if (company_id && isUUID(company_id)) {
    query = query.eq('company_id', company_id);
  }

  const now = Date.now();
  if (filter === 'hot') {
    query = query
      .gte('last_activity_at', new Date(now - 14 * 86400000).toISOString())
      .gte('deal_health_score', 45);
  } else if (filter === 'engaged') {
    query = query.gte('last_activity_at', new Date(now - 60 * 86400000).toISOString());
  }

  query = query.range(offsetNum, offsetNum + limitNum - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  // Overlay v2 substrate values on top of the v1 rows where claims/identifiers/
  // predictions carry fresher data. Phase 4a — v1 columns remain the fallback.
  const rows = (data || []) as Record<string, unknown>[];
  const overlays = await fetchEntityOverlays(supabase, rows.map(r => r.id as string));

  return {
    contacts: rows.map(r => formatContact(applyContactOverlay(r, overlays.get(r.id as string)))),
    total: count || 0,
    limit: limitNum,
    offset: offsetNum,
  };
}

export async function getContactByIdentifier(
  supabase: SupabaseClient,
  workspaceId: string,
  identifier: string,
): Promise<ContactProfile | null> {
  let row: Record<string, unknown> | null = null;

  if (isUUID(identifier)) {
    const { data } = await supabase.from('contacts').select(CONTACT_SELECT).eq('id', identifier).eq('workspace_id', workspaceId).single();
    row = data;
  } else if (isEmail(identifier)) {
    const { data } = await supabase.from('contacts').select(CONTACT_SELECT).eq('email', identifier.toLowerCase()).eq('workspace_id', workspaceId).single();
    row = data;
  } else {
    return null;
  }

  if (!row) return null;

  // Overlay the v2 substrate onto the v1 contact row.
  const overlays = await fetchEntityOverlays(supabase, [row.id as string]);
  row = applyContactOverlay(row, overlays.get(row.id as string));

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: activityRows },
    companyResult,
    { data: recentSignals },
    { data: contactMems },
    companyMemResult,
  ] = await Promise.all([
    listActivities(supabase, { contactId: row.id as string, limit: 25 }).then(data => ({ data })),
    row.company_id
      ? supabase.from('companies').select('name, domain, industry, employee_count, location').eq('id', row.company_id).single()
      : Promise.resolve({ data: null }),
    listActivities(supabase, { contactId: row.id as string, since: thirtyDaysAgo, limit: 500 }).then(data => ({ data })),
    listNotes(supabase, workspaceId, { entityId: row.id as string, limit: 20 }).then(data => ({ data })),
    row.company_id
      ? listNotes(supabase, workspaceId, { entityId: row.company_id as string, limit: 20 }).then(data => ({ data }))
      : Promise.resolve({ data: [] }),
  ]);

  const signals30d = ((recentSignals as { activity_type: string }[] | null) || []).reduce<Record<string, number>>((acc, a) => {
    acc[a.activity_type] = (acc[a.activity_type] || 0) + 1;
    return acc;
  }, {});

  // MemoryFact.category is the v1 fixed enum; notes carry an open string.
  // Cast at the boundary — runtime values are user-supplied either way.
  const toFact = (scope: 'contact' | 'company') => (m: import('./notes.js').Note) => ({
    scope,
    category: m.category as MemoryCategory,
    content: m.content,
    written_at: m.created_at ? m.created_at.split('T')[0] : null,
    graph_layer: ((m.metadata?.graph_layer as string) ?? 'private') as 'private' | 'public',
  });
  const facts = [
    ...((contactMems || []) as import('./notes.js').Note[]).map(toFact('contact')),
    ...((companyMemResult.data || []) as import('./notes.js').Note[]).map(toFact('company')),
  ];

  const channels = (() => {
    const ch = row.channels as Record<string, unknown> | null;
    if (!ch?.linkedin) return ch;
    return { ...ch, linkedin: computeLinkedInChannel(ch.linkedin as Record<string, unknown>) };
  })();

  return {
    id: row.id as string,
    email: row.email as string,
    name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
    company: (row.company as string) || (companyResult.data as Record<string, string>)?.name || null,
    company_id: (row.company_id as string) || null,
    title: (row.job_title as string) || null,
    linkedin_url: (row.linkedin_url as string) || null,
    photo_url: (row.photo_url as string) || null,
    channels,
    pipeline_stage: ((row.pipeline_stage as string) || 'identified') as Contact['pipeline_stage'],
    icp_fit: (row.icp_fit as string) ?? null,
    icp_score: (row.icp_score as number) ?? null,
    deal_health_score: (row.deal_health_score as number) ?? null,
    last_activity_at: (row.last_activity_at as string) || null,
    memory_summary: (row.memory_summary as string) || null,
    company_details: companyResult.data as ContactProfile['company_details'],
    activities: ((activityRows as Array<{ id: string; activity_type: string; description: string | null; summary: string | null; raw_data: Record<string, unknown> | null; source: string | null; occurred_at: string }> | null) || []).map(a => ({
      id: a.id,
      type: a.activity_type,
      description: a.description || a.summary || null,
      body: ((a.raw_data as Record<string, unknown> | null)?.body as string | null) || ((a.raw_data as Record<string, unknown> | null)?.message as string | null) || null,
      source: a.source || null,
      occurred_at: a.occurred_at,
    })),
    facts,
    signals_30d: signals30d,
  };
}

export async function createContact(
  supabase: SupabaseClient,
  workspaceId: string,
  params: CreateContactParams,
): Promise<ContactListItem> {
  const { data, error } = await supabase
    .from('contacts')
    .insert({
      workspace_id: workspaceId,
      email: params.email.toLowerCase().trim(),
      first_name: params.first_name?.trim() || null,
      last_name: params.last_name?.trim() || null,
      company: params.company?.trim() || null,
      job_title: params.job_title?.trim() || null,
      phone: params.phone?.trim() || null,
      linkedin_url: normaliseLinkedInUrl(params.linkedin_url || null),
      notes: params.notes?.trim() || null,
      pipeline_stage: 'identified',
      source: 'api',
    })
    .select(CONTACT_LIST_SELECT)
    .single();

  if (error) {
    if (error.code === '23505') throw Object.assign(new Error('email_already_exists'), { status: 409 });
    throw error;
  }

  return formatContact(data);
}

export async function updateContact(
  supabase: SupabaseClient,
  workspaceId: string,
  identifier: string,
  params: UpdateContactParams,
): Promise<ContactListItem | null> {
  const existing = await getContactByIdentifier(supabase, workspaceId, identifier);
  if (!existing) return null;

  const updates: Record<string, unknown> = {};
  if (params.first_name !== undefined) updates.first_name = params.first_name.trim() || null;
  if (params.last_name !== undefined) updates.last_name = params.last_name.trim() || null;
  if (params.company !== undefined) updates.company = params.company.trim() || null;
  if (params.job_title !== undefined) updates.job_title = params.job_title.trim() || null;
  if (params.phone !== undefined) updates.phone = params.phone.trim() || null;
  if (params.linkedin_url !== undefined) updates.linkedin_url = normaliseLinkedInUrl(params.linkedin_url);
  if (params.notes !== undefined) updates.notes = params.notes.trim() || null;

  const { data, error } = await supabase
    .from('contacts')
    .update(updates)
    .eq('id', existing.id)
    .eq('workspace_id', workspaceId)
    .select(CONTACT_LIST_SELECT)
    .single();

  if (error) throw error;
  return formatContact(data);
}

export async function deleteContact(
  supabase: SupabaseClient,
  workspaceId: string,
  identifier: string,
): Promise<{ contact_id: string; email: string } | null> {
  const existing = await getContactByIdentifier(supabase, workspaceId, identifier);
  if (!existing) return null;

  // Invalidate every note on this contact-entity. Event observations stay —
  // they're the append-only audit trail (deleting a contact doesn't unhappen
  // the emails/meetings). They go away when the entity row is deleted.
  await supabase
    .from('claims')
    .update({ invalid_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('entity_id', existing.id)
    .like('property', 'note.%');

  await supabase.from('contacts').delete().eq('id', existing.id).eq('workspace_id', workspaceId);

  return { contact_id: existing.id, email: existing.email };
}
