-- The decision loop — recommendation → verdict → action → outcome, as one labelled row.
--
-- The engine already learns behaviour → outcome (ri_observations) and already grades its
-- own advice once an action was sent from OUR surface (ri_decision_traces, stamped via
-- raw.rec_id in studio.mjs / linkedinSend.mjs). Two columns of that dataset were missing
-- entirely the moment the work moved into a coding agent:
--
--   1. WHAT WAS RECOMMENDED — a plugin recommendation is produced by the user's own agent
--      inside a skill, so it lived only in chat scrollback and was never written down.
--   2. WHAT THE HUMAN DID WITH IT — accepted / edited / rejected. The edit in particular is
--      the highest-signal label we can collect and nobody else can: only a system sitting
--      BETWEEN the draft and the send sees both versions. A CRM only ever sees the sent one.
--
-- ri_decisions closes both. It is deliberately surface-agnostic: the same row shape is
-- written by the Claude Code plugin, by any other agent over plain HTTP, and by our own
-- app (actions.mjs approve/reject). `surface` + `agent` record which produced it, so the
-- learning layer can ask "does the app's advice get edited more than the plugin's?".
--
-- Trust model — three lanes, and the schema keeps them distinct on purpose:
--   Tier 3 (the agent says so) → proposal + verdict. Cheap, immediate, UNVERIFIED.
--   Tier 2 (a hook saw the tool execute) → confirm, carrying the provider's message id.
--   Tier 1 (the provider's webhook) → the outcome, resolved by decisionTraces.mjs.
-- A proposal accepted but never confirmed matures to status='unconfirmed'. That row is
-- not a bug: it is the intent-to-action gap — the agent claiming a send that never
-- happened, or the human saying "yes, do it" and never doing it. A CRM cannot record it.
--
-- Raw stays at the edge. We store a hash and a git pointer for the drafted and sent
-- bodies, plus the derived edit metrics — never the body text itself.

create table if not exists public.ri_decisions (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  -- Caller-supplied idempotency key, and the value stamped onto the resulting action so
  -- the confirmation can find its way home. Opaque to us (the plugin uses a ULID-ish
  -- string); unique per workspace so a retried propose is a no-op, not a duplicate row.
  decision_id          text not null,
  entity_id            uuid,                            -- the account/person it concerns
  rec_id               uuid,                            -- ri_recommendations, when the engine produced it
  -- The ICP score AS IT STOOD when we acted, not as it stands now.
  --
  -- This is a leakage guard, and it is the reason this column exists before the table has a
  -- single row in it. Today's score moved partly BECAUSE the deal progressed; joining it back
  -- to a March decision would train on hindsight and produce a correlation that predicts
  -- nothing. The score cannot be reconstructed after the fact, so a decision recorded without
  -- this is permanently unlabelable for ICP.
  --
  -- Both the pointer and the value: predictions are append-only (a fresh score stakes a new
  -- row), but resolution and model changes still move what the row MEANS, and the analysis
  -- needs the number as it read on the day.
  prediction_id        uuid,
  icp_score_at_decision double precision,
  -- Which surface proposed it. Not cosmetic: it is the segmentation column for
  -- "whose advice actually converts", and it is how app and plugin stay comparable.
  surface              text not null default 'agent',   -- plugin | app | agent | api
  agent                text,                            -- claude-code | codex | nous-studio | ...
  category             text,                            -- outreach | follow_up | stage_change | research | ...
  action_type          text,                            -- email_send | linkedin_message | campaign_add | ...
  -- Who it was going to. This is what lets a PostToolUse hook — which sees a send tool
  -- fire but has never heard of our decision_id — find the proposal it belongs to. Without
  -- it the hook could only confirm decisions the agent remembered to reference, which is
  -- exactly the discretionary behaviour the hook exists to stop relying on.
  recipient            text,
  -- The recommendation itself, in one line the human could have read.
  proposal             text not null,
  proposal_ref         text,                            -- git pointer to the drafted body
  proposal_hash        text,                            -- sha256 of the drafted body
  -- What the human did with it. 'pending' until they answer; 'edited' when they sent
  -- something materially different from what was drafted.
  verdict              text not null default 'pending', -- pending | accepted | edited | rejected
  verdict_at           timestamptz,
  verdict_note         text,                            -- what they said when they said no
  edit_distance        integer,                         -- token-level, drafted vs sent
  edit_ratio           double precision,                -- 0.0 = verbatim, 1.0 = rewritten
  -- Did the action actually happen, and how do we know.
  status               text not null default 'proposed',-- proposed | confirmed | unconfirmed | abandoned
  confirmed_at         timestamptz,
  confirmed_via        text,                            -- hook | webhook | app | agent
  provider             text,                            -- gmail | instantly | heyreach | unipile | ...
  -- THE join key. The hook captures it from the send tool's own response; the outcome
  -- webhook carries the same id (instantly.mjs already keys idempotency on message_id).
  -- This is how decision → outcome closes without trusting anybody's narration.
  provider_message_id  text,
  send_observation_id  uuid,                            -- once matched to the observation
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (workspace_id, decision_id)
);
create index if not exists ri_decisions_ws_status_idx   on public.ri_decisions (workspace_id, status, created_at desc);
create index if not exists ri_decisions_ws_verdict_idx  on public.ri_decisions (workspace_id, verdict, category);
create index if not exists ri_decisions_entity_idx      on public.ri_decisions (workspace_id, entity_id);
create index if not exists ri_decisions_msgid_idx       on public.ri_decisions (workspace_id, provider, provider_message_id);
create index if not exists ri_decisions_recipient_idx   on public.ri_decisions (workspace_id, recipient, status);

-- ri_decision_traces predates the migrations directory (it was applied directly). Declared
-- here so a fresh database builds a working engine; `if not exists` makes it a no-op on prod.
create table if not exists public.ri_decision_traces (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null,
  rec_id                 uuid,
  entity_id              uuid not null,
  send_observation_id    uuid not null,
  action_property        text not null,
  sent_at                timestamptz not null,
  outcome                text,
  outcome_observation_id uuid,
  outcome_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (workspace_id, send_observation_id)
);

-- The trace's link back to the decision. A plugin action has no ri_recommendations row
-- (its recommendation came from the user's agent, not our engine), so rec_id is null and
-- decision_id is the only handle — without this column those traces resolve an outcome
-- that nothing can attribute.
alter table public.ri_decision_traces
  add column if not exists decision_id text;
create index if not exists ri_decision_traces_decision_idx
  on public.ri_decision_traces (workspace_id, decision_id);

-- Backend-only, exactly like the other ri_ tables: the API and worker reach it with the
-- service role and the frontend never queries it directly. RLS on with no policy = deny all.
alter table public.ri_decisions enable row level security;
alter table public.ri_decision_traces enable row level security;
