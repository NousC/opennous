-- Active accounts — the billing meter.
--
-- An active account is a COMPANY we have actually had a conversation with. Not a
-- row, not a lead, not a person: a company with at least one real interaction on
-- it, or on somebody who works there.
--
-- Why this and not the old meters:
--
--   Retrievals were free to serve (get_context and friends are deterministic
--   Postgres reads with no model in the path) and nobody came close to the cap —
--   our own workspace used 311 of 5,000 in a month. Billing the free thing.
--
--   Records were worse. A 2,000-lead import costs us nothing: no model call, no
--   extraction, nothing. Charging for storage would have priced the cheapest
--   thing we do.
--
-- What actually costs money is turning an interaction into structured context,
-- and that only happens once somebody replies. So the meter counts exactly the
-- accounts we did work on, and the import stays free. "Import 2,000 leads for
-- free; the 50 that reply are the ones you pay for" is not a marketing line, it
-- is a description of our cost.
--
-- Excluded, deliberately:
--   * merged + archived entities — archiving is how you get back under the cap
--     without losing anything (the record stays readable, it stops counting).
--   * internal teammates — a colleague on a call is not an account.
--   * outbound-only contacts — an email we SENT is not a conversation. This is
--     what keeps a cold list free.

-- The interaction types that make an account active. Deliberately the same set
-- the signal extractor fires on (SIGNAL_WORTHY_TYPES in worker/src/signals),
-- because "an account we did LLM work on" and "an account we bill for" must be
-- the same set or the meter drifts from the cost.
--
-- Note what is NOT here: email_sent, linkedin_message_sent, email_opened,
-- added_to_campaign, icp_scored, enrichment_run. All of those are things WE do
-- TO a lead. None of them make it an account.
CREATE OR REPLACE FUNCTION active_account_interaction_properties()
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'interaction.email_received',
    'interaction.email_reply',
    'interaction.reply',
    'interaction.positive_reply',
    'interaction.linkedin_message',
    'interaction.linkedin_reply',
    'interaction.linkedin_replied',
    'interaction.slack_dm',
    'interaction.slack_message',
    'interaction.meeting_held'
  ]
$$;

-- Count a team's active accounts across all its workspaces.
--
-- A person with no company still counts as one account — a solo founder who
-- replies to you is a real account, and it would be strange to bill for them only
-- once we happen to learn where they work.
CREATE OR REPLACE FUNCTION team_active_accounts(ws_ids UUID[])
RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  WITH interacted AS (
    -- Every entity we have genuinely conversed with.
    SELECT DISTINCT o.entity_id
    FROM observations o
    WHERE o.workspace_id = ANY(ws_ids)
      AND o.kind = 'event'
      AND o.property = ANY(active_account_interaction_properties())
  ),
  live AS (
    -- Drop the merged, the archived, and our own team.
    SELECT i.entity_id, e.type
    FROM interacted i
    JOIN entities e ON e.id = i.entity_id
    WHERE e.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM claims c
        WHERE c.entity_id = i.entity_id
          AND c.property = 'is_internal'
          AND c.value = 'true'::jsonb
          AND c.invalid_at IS NULL
      )
  ),
  accounts AS (
    -- A person rolls up to their company; a company counts directly; a person with
    -- no company is their own account. COALESCE collapses the first and third case.
    SELECT COALESCE(ct.company_id, l.entity_id) AS account_id
    FROM live l
    LEFT JOIN contacts ct ON ct.id = l.entity_id AND l.type = 'person'
  )
  SELECT COUNT(DISTINCT account_id) FROM accounts;
$$;

-- Mirrors team_ops_grace. Same warn -> grace -> restrict shape, own clock, so a
-- team over on accounts is not entangled with any other meter's state.
CREATE TABLE IF NOT EXISTS team_accounts_grace (
  team_id           UUID PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  grace_started_at  TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
