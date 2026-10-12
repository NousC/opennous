-- Phase 2 — generalize authority reconciliation past `lifecycle`.
--
-- Until now only `lifecycle` resolved by source authority; every other property (a person's
-- title, a company's headcount, an email's deliverability) resolved by plain recency, so a
-- newer low-quality source silently overwrote an older authoritative one. This seeds the
-- source_authority weights for three more axes registered in canonicalAxes.ts
-- (reachability_status, job_title, employee_count). No source_field_map rows are needed:
-- every source writes these properties directly under the same name, so the values are
-- already comparable — only the trust ordering was missing.
--
-- Authority ∈ [0,1]; unlisted sources fall to the engine default (0.4). Additive, idempotent.

insert into source_authority (workspace_id, canonical_property, source, authority, event_ground_truth)
values
  -- ── reachability_status — a dedicated verifier is near-ground-truth; an enrichment
  --    provider only GUESSES deliverability while finding the address. The verifier must
  --    win even when the guess is newer (the recency bug this fixes).
  (null, 'reachability_status', 'neverbounce',    0.95, false),
  (null, 'reachability_status', 'millionverifier',0.95, false),
  (null, 'reachability_status', 'bounceban',      0.90, false),
  (null, 'reachability_status', 'prospeo',        0.55, false),
  (null, 'reachability_status', 'apollo',         0.45, false),
  (null, 'reachability_status', 'aiark',          0.45, false),
  (null, 'reachability_status', 'user',           0.90, false),

  -- ── job_title — LinkedIn is the person's own current title; enrichment DBs are next;
  --    CRM titles are human-entered and go stale. Freshness decay still lets a FRESH CRM
  --    title overtake a stale LinkedIn one, so this is trust-ordering, not a hard override.
  (null, 'job_title', 'linkedin',   0.90, false),
  (null, 'job_title', 'unipile',    0.90, false),
  (null, 'job_title', 'apollo',     0.60, false),
  (null, 'job_title', 'prospeo',    0.55, false),
  (null, 'job_title', 'aiark',      0.55, false),
  (null, 'job_title', 'salesforce', 0.50, false),
  (null, 'job_title', 'hubspot',    0.50, false),
  (null, 'job_title', 'pipedrive',  0.50, false),
  (null, 'job_title', 'attio',      0.50, false),
  (null, 'job_title', 'close',      0.50, false),
  (null, 'job_title', 'user',       0.90, false),
  (null, 'job_title', 'import',     0.45, false),
  (null, 'job_title', 'csv',        0.45, false),

  -- ── employee_count — firmographic providers over a stale/blank CRM headcount.
  (null, 'employee_count', 'linkedin',   0.80, false),
  (null, 'employee_count', 'aiark',      0.70, false),
  (null, 'employee_count', 'apollo',     0.70, false),
  (null, 'employee_count', 'prospeo',    0.55, false),
  (null, 'employee_count', 'salesforce', 0.50, false),
  (null, 'employee_count', 'hubspot',    0.50, false),
  (null, 'employee_count', 'pipedrive',  0.50, false),
  (null, 'employee_count', 'attio',      0.50, false),
  (null, 'employee_count', 'user',       0.90, false)
on conflict do nothing;
