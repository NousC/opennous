import type { SupabaseClient } from '@supabase/supabase-js';
import { embed } from '../embed.js';
import { upsertFlag } from './flags.js';
import { listInsightThemes, setInsightThemeStatus } from './insights.js';

// Shipped-feature store + the objection→feature matcher (the Phase B wedge). When you log
// a feature you shipped, this ties it to the OPEN objections it resolves and the Insights
// themes it answers — closing the loop in BOTH places from one matcher:
//   • objection claim  → status flipped to 'resolved' (drops Blocker Severity next
//                        deal-health read) + an `objection_resolved` re-engage flag
//   • insight theme    → status flipped to 'shipped'
// v1 is embedding-similarity (cosine) with a ship-date gate; an LLM confirm pass can
// tighten it later. See docs/accounts-flagging-brief.md.

export interface WorkspaceFeature {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  shipped_at: string;
  embedding: number[] | null;
  created_at: string;
}

// Embeddings only weakly separate short claim texts (a real match sits ~0.25), so cosine
// is a PRE-FILTER that gathers candidates; an injected LLM confirm pass (confirmMatch)
// decides the real ties. Without a confirmer we fall back to a stricter cosine cutoff.
const CANDIDATE_FLOOR = 0.22;   // gather anything plausibly related
const CANDIDATE_CAP = 25;       // most-similar N handed to the confirmer
const OBJECTION_FALLBACK = 0.30;
const THEME_FALLBACK = 0.34;

// The API supplies this (Haiku); core stays LLM-free. Given the feature and a set of
// candidate texts, return the ids the feature genuinely resolves.
export type ConfirmMatch = (
  feature: { title: string; description: string | null },
  candidates: { id: string; text: string }[],
) => Promise<Set<string>>;

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// claims.embedding (pgvector) serializes as a "[...]" string over PostgREST; a jsonb
// feature embedding comes back as an array. Handle both.
function parseVec(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch { return null; } }
  return null;
}

export async function addFeature(
  supabase: SupabaseClient,
  workspaceId: string,
  p: { title: string; description?: string | null; shippedAt?: string | null },
): Promise<WorkspaceFeature> {
  const embedding = await embed(`${p.title}. ${p.description ?? ''}`.trim());
  const { data, error } = await supabase
    .from('workspace_features')
    .insert({
      workspace_id: workspaceId,
      title: p.title,
      description: p.description ?? null,
      shipped_at: p.shippedAt ?? new Date().toISOString(),
      embedding: embedding ?? null,
    })
    .select('id, workspace_id, title, description, shipped_at, embedding, created_at')
    .single();
  if (error) throw error;
  return data as unknown as WorkspaceFeature;
}

export async function listFeatures(supabase: SupabaseClient, workspaceId: string): Promise<WorkspaceFeature[]> {
  const { data, error } = await supabase
    .from('workspace_features')
    .select('id, workspace_id, title, description, shipped_at, embedding, created_at')
    .eq('workspace_id', workspaceId)
    .order('shipped_at', { ascending: false });
  if (error) throw error;
  return (data as unknown as WorkspaceFeature[]) ?? [];
}

/**
 * Match a shipped feature to what it resolves. Only touches objections raised BEFORE the
 * ship date (a feature can't have resolved an objection voiced after it shipped). Returns
 * a summary of what changed.
 */
export async function applyShippedFeature(
  supabase: SupabaseClient,
  workspaceId: string,
  feature: WorkspaceFeature,
  opts: { confirmMatch?: ConfirmMatch } = {},
): Promise<{ objectionsResolved: number; flagsRaised: number; themesShipped: number }> {
  const vec = feature.embedding ?? (await embed(`${feature.title}. ${feature.description ?? ''}`.trim()));
  if (!vec) return { objectionsResolved: 0, flagsRaised: 0, themesShipped: 0 };
  const shippedAt = new Date(feature.shipped_at).getTime();
  const featureRef = { title: feature.title, description: feature.description };

  // ── Objections → resolve + flag ──
  const { data: objRows } = await supabase
    .from('claims')
    .select('id, entity_id, value, valid_from, embedding')
    .eq('workspace_id', workspaceId)
    .like('property', 'note.%')
    .is('invalid_at', null)
    .filter('value->>category', 'eq', 'objection');

  // Pre-filter to plausible candidates by cosine + ship-date gate.
  const candidates: { row: any; sim: number }[] = [];
  for (const c of (objRows as any[]) ?? []) {
    const status = c.value?.metadata?.status ?? 'open';
    if (status !== 'open') continue;
    if (!c.valid_from || new Date(c.valid_from).getTime() >= shippedAt) continue;
    const emb = parseVec(c.embedding);
    if (!emb) continue;
    const sim = cosine(vec, emb);
    if (sim >= CANDIDATE_FLOOR) candidates.push({ row: c, sim });
  }
  candidates.sort((a, b) => b.sim - a.sim);
  const shortlist = candidates.slice(0, CANDIDATE_CAP);

  // Confirm the real ties: LLM if provided, else a stricter cosine cutoff.
  let matches: { row: any; sim: number }[];
  if (opts.confirmMatch && shortlist.length) {
    const ok = await opts.confirmMatch(featureRef, shortlist.map(m => ({ id: m.row.id, text: String(m.row.value?.content ?? m.row.value?.label ?? '') })));
    matches = shortlist.filter(m => ok.has(m.row.id));
  } else {
    matches = shortlist.filter(m => m.sim >= OBJECTION_FALLBACK);
  }

  // Resolve person→company so the flag lands on the account.
  const entityIds = [...new Set(matches.map(m => m.row.entity_id))];
  let personCompany = new Map<string, string>();
  if (entityIds.length) {
    const { data: contacts } = await supabase.from('contacts').select('id, company_id').in('id', entityIds);
    personCompany = new Map((contacts as any[] ?? []).filter(r => r.company_id).map(r => [r.id, r.company_id]));
  }

  let objectionsResolved = 0, flagsRaised = 0;
  const nowIso = new Date().toISOString();
  for (const { row } of matches) {
    const newValue = {
      ...row.value,
      metadata: { ...(row.value?.metadata ?? {}), status: 'resolved', resolved_by_feature: feature.id, resolved_at: nowIso },
    };
    const { error } = await supabase.from('claims').update({ value: newValue }).eq('id', row.id);
    if (error) continue;
    objectionsResolved++;
    const companyId = personCompany.get(row.entity_id) ?? row.entity_id;
    const label = row.value?.label ?? 'an objection';
    const f = await upsertFlag(supabase, workspaceId, {
      entityId: companyId,
      flagType: 'objection_resolved',
      reason: `They stalled on "${label}" — you shipped "${feature.title}". Re-engage with what they said.`,
      evidence: { claim_ids: [row.id], feature_id: feature.id },
      momentumScore: 80, priority: 80, source: 'event',
    });
    if (f) flagsRaised++;
  }

  // ── Insight themes → mark shipped (the same feature answering a product ask) ──
  let themesShipped = 0;
  try {
    const themes = (await listInsightThemes(supabase, workspaceId, 'external'))
      .filter(t => t.status !== 'shipped' && t.status !== 'dismissed');
    const scored: { t: any; sim: number }[] = [];
    for (const t of themes) {
      const tvec = await embed(`${t.title}. ${t.takeaway ?? ''}`.trim());
      if (tvec) scored.push({ t, sim: cosine(vec, tvec) });
    }
    const themeShortlist = scored.filter(s => s.sim >= CANDIDATE_FLOOR).sort((a, b) => b.sim - a.sim).slice(0, CANDIDATE_CAP);
    let themeMatches: { t: any; sim: number }[];
    if (opts.confirmMatch && themeShortlist.length) {
      const ok = await opts.confirmMatch(featureRef, themeShortlist.map(s => ({ id: s.t.id, text: `${s.t.title}. ${s.t.takeaway ?? ''}` })));
      themeMatches = themeShortlist.filter(s => ok.has(s.t.id));
    } else {
      themeMatches = themeShortlist.filter(s => s.sim >= THEME_FALLBACK);
    }
    for (const { t } of themeMatches) {
      await setInsightThemeStatus(supabase, workspaceId, t.id, 'shipped');
      themesShipped++;
    }
  } catch { /* insights themes optional — never block the objection loop */ }

  return { objectionsResolved, flagsRaised, themesShipped };
}
