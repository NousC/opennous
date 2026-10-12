// Per-account context the signals / meeting / journey lenses read: which claim
// categories have been discussed, how many buying signals fired, and how many
// meetings were held — all aggregated to the company from its contacts. One pass,
// a few queries, shared by three jobs. No LLM — reads claims/observations we already
// extracted (the meeting lens is claim-based, not fresh transcript analysis).

export async function accountContext(supabase, workspaceId) {
  const { data: contacts } = await supabase.from('contacts')
    .select('id, company_id').eq('workspace_id', workspaceId).not('company_id', 'is', null);
  const personCompany = new Map((contacts ?? []).map((c) => [c.id, c.company_id]));
  const companyIds = new Set((contacts ?? []).map((c) => c.company_id));

  const ctx = new Map();
  const ensure = (id) => { if (!ctx.has(id)) ctx.set(id, { categories: new Set(), buyingSignals: 0, meetings: 0, recent: 0, prior: 0 }); return ctx.get(id); };
  const toCompany = (entityId) => (companyIds.has(entityId) ? entityId : personCompany.get(entityId));
  const DAY = 86_400_000;
  const now = Date.now();

  // Claim categories discussed, per account (what's been qualified).
  const { data: claims } = await supabase.from('claims')
    .select('entity_id, value').eq('workspace_id', workspaceId)
    .like('property', 'note.%').is('invalid_at', null);
  for (const cl of claims ?? []) {
    const cid = toCompany(cl.entity_id);
    if (!cid) continue;
    const cat = String(cl.value?.category ?? '').toLowerCase();
    const x = ensure(cid);
    if (cat) x.categories.add(cat);
    if (cat === 'buying_signal') x.buyingSignals += 1;
  }

  // Meetings held, all-time, per account (the journey touch that matters most).
  const { data: mtgs } = await supabase.from('observations')
    .select('entity_id').eq('workspace_id', workspaceId).eq('property', 'interaction.meeting_held');
  for (const m of mtgs ?? []) {
    const cid = toCompany(m.entity_id);
    if (cid) ensure(cid).meetings += 1;
  }

  // Engagement touches in the last 60 days, split recent (0-30d) vs prior (30-60d),
  // so a cooling trend (recent well below prior) can be detected.
  const { data: touches } = await supabase.from('observations')
    .select('entity_id, observed_at')
    .eq('workspace_id', workspaceId)
    .in('property', ['interaction.meeting_held', 'interaction.email_received', 'interaction.email_sent'])
    .gte('observed_at', new Date(now - 60 * DAY).toISOString());
  for (const t of touches ?? []) {
    const cid = toCompany(t.entity_id);
    if (!cid) continue;
    const age = (now - new Date(t.observed_at).getTime()) / DAY;
    const x = ensure(cid);
    if (age <= 30) x.recent += 1; else x.prior += 1;
  }

  return ctx;
}
