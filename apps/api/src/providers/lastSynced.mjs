/**
 * When did each connection last bring something in? (GET-631)
 *
 * `workflow_provider_connections.last_used_at` is never written, so the honest answer comes from
 * the data itself: the newest observation whose `source` is the provider's slug, and for a CRM the
 * sync's own `crm_sync_configs.last_synced_at`. The later of the two wins. A personal source reads
 * only its owner's observations, so one person's Gmail never shows a teammate's sync time.
 *
 * A source writes as its slug or as `<slug>_live` (the live/webhook path), so both are read. Each
 * is its own equality lookup, served by observations_ws_source_ingested with ORDER BY … LIMIT 1;
 * an IN over the two would have to sort every row of both sources. The ILIKE prefix fallback the
 * governance page uses is a sequential scan and is not worth it for a card label.
 * Every lookup is best-effort with a short deadline, and the observation and CRM lookups run in
 * parallel, so the whole call stays within one deadline (~1.5s). A miss is `null`, never an error.
 */

/** The observation sources a provider's data lands under. */
export const sourcesFor = (key) => (key ? [key, `${key}_live`] : []);

/** gmail_oauth → gmail. The observation source for a provider slug. */
export function sourceKeyFor(providerName) {
  const n = String(providerName || '').toLowerCase().trim();
  if (!n) return null;
  return n.replace(/_oauth$/, '');
}

const latest = (a, b) => {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
};

export const withDeadline = (p, ms) => {
  let timer;
  return Promise.race([
    Promise.resolve(p).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Map connection id → ISO timestamp (or null).
 * `conns` rows carry: id, owner_user_id, provider { name }, and `scope` ('personal' | 'company').
 */
export async function lastSyncedByConnection(supabase, workspaceId, conns, { deadlineMs = 1500 } = {}) {
  const out = new Map();
  if (!conns?.length) return out;

  // One observation lookup per (source, owner-or-everyone) pair, not per connection.
  const lookups = new Map();
  for (const c of conns) {
    const key = sourceKeyFor(c.provider?.name);
    if (!key) continue;
    const owner = c.scope === 'personal' ? (c.owner_user_id ?? null) : null;
    const k = `${key}|${owner ?? '*'}`;
    if (!lookups.has(k)) lookups.set(k, { key, owner });
  }

  const newestOf = async (source, owner) => {
    let q = supabase.from('observations').select('ingested_at')
      .eq('workspace_id', workspaceId).eq('source', source);
    if (owner) q = q.eq('owner_user_id', owner);
    const { data, error } = await q.order('ingested_at', { ascending: false }).limit(1);
    if (error) return null;
    return data?.[0]?.ingested_at ?? null;
  };

  const observed = new Map();
  const observations = Promise.all([...lookups].map(async ([k, { key, owner }]) => {
    const times = await Promise.all(sourcesFor(key).map((src) => withDeadline(newestOf(src, owner), deadlineMs)));
    observed.set(k, times.reduce(latest, null));
  }));

  // CRM syncs keep their own clock. Read alongside the observations, not after them.
  const crm = new Map();
  const ids = conns.map((c) => c.id).filter(Boolean);
  const crmRead = ids.length
    ? withDeadline(
      supabase.from('crm_sync_configs').select('connection_id, last_synced_at').in('connection_id', ids.slice(0, 200)),
      deadlineMs,
    ).then((res) => {
      if (res && !res.error) for (const r of res.data || []) crm.set(r.connection_id, r.last_synced_at ?? null);
    })
    : null;

  await Promise.all([observations, crmRead]);

  for (const c of conns) {
    const key = sourceKeyFor(c.provider?.name);
    const owner = c.scope === 'personal' ? (c.owner_user_id ?? null) : null;
    const fromObs = key ? observed.get(`${key}|${owner ?? '*'}`) ?? null : null;
    out.set(c.id, latest(fromObs, crm.get(c.id) ?? null));
  }
  return out;
}
