import type { SupabaseClient } from '@supabase/supabase-js';
import { isUUID } from '../utils/identity.js';
import { listNotes } from './notes.js';
import { fetchEntityOverlays, applyContactOverlay, applyCompanyOverlay } from './entities.js';

export interface CompanyProfile {
  company_id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employee_count: number | null;
  location: string | null;
  deal_health_score: number | null;
  contacts: CompanyContact[];
  total_contacts: number;
  facts: CompanyFact[];
}

interface CompanyContact {
  contact_id: string;
  name: string | null;
  email: string;
  title: string | null;
  pipeline_stage: string;
}

interface CompanyFact {
  category: string;
  content: string;
  written_at: string | null;
}

export async function getCompanyProfile(
  supabase: SupabaseClient,
  workspaceId: string,
  companyId: string,
): Promise<CompanyProfile | null> {
  if (!isUUID(companyId)) return null;

  const [companyResult, contactsResult, factsResult] = await Promise.all([
    supabase
      .from('companies')
      .select('id, name, domain, industry, employee_count, location, deal_health_score')
      .eq('id', companyId)
      .eq('workspace_id', workspaceId)
      .single(),
    supabase
      .from('contacts')
      .select('id, email, first_name, last_name, job_title, pipeline_stage', { count: 'exact' })
      .eq('company_id', companyId)
      .eq('workspace_id', workspaceId)
      .order('last_activity_at', { ascending: false })
      .limit(20),
    listNotes(supabase, workspaceId, { entityId: companyId, limit: 20 }).then(data => ({ data })),
  ]);

  if (!companyResult.data) return null;

  // Overlay v2 substrate values on the company row + on each of its contacts.
  const contactRows = (contactsResult.data || []) as Record<string, unknown>[];
  const ids = [companyId, ...contactRows.map(c => c.id as string)];
  const overlays = await fetchEntityOverlays(supabase, ids);
  const c = applyCompanyOverlay(companyResult.data as Record<string, unknown>, overlays.get(companyId));
  const contacts = contactRows.map(r => applyContactOverlay(r, overlays.get(r.id as string)));

  return {
    company_id: c.id as string,
    name: c.name as string,
    domain: (c.domain as string) || null,
    industry: (c.industry as string) || null,
    employee_count: (c.employee_count as number) || null,
    location: (c.location as string) || null,
    deal_health_score: (c.deal_health_score as number) || null,
    contacts: contacts.map(con => ({
      contact_id: con.id as string,
      name: [con.first_name, con.last_name].filter(Boolean).join(' ') || null,
      email: con.email as string,
      title: (con.job_title as string) || null,
      pipeline_stage: (con.pipeline_stage as string) || 'identified',
    })),
    total_contacts: contactsResult.count || 0,
    facts: (factsResult.data || []).map(f => ({
      category: f.category,
      content: f.content,
      written_at: f.created_at || null,
    })),
  };
}
