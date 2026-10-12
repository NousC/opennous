-- agent_actions — the record of what the AGENT changed, and the state to put back.
--
-- Citations answer "where did that come from". This answers the other half, which starts
-- mattering the moment the agent can change things rather than only read them: what did it
-- DO, why, on whose behalf, and can I put it back.
--
-- `audit_log` already exists and is not this. It records what a PERSON did through an HTTP
-- route — who invited whom, who rotated a key — and it stores no before-state, so it can
-- tell you a thing happened and never undo it. This table holds the previous value, which
-- is the whole point: an audit trail you cannot act on is a receipt.
--
-- Scope is deliberately narrow. Only tools whose previous state is a clean snapshot and
-- whose restore is genuinely correct are recorded here (see lib/agentActions.mjs). A row in
-- this table PROMISES an undo. Recording something we cannot actually reverse, and showing
-- the button anyway, would be worse than not recording it.
create table if not exists public.agent_actions (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,

  -- Where it happened, so the card can render in the conversation that caused it. Both are
  -- nullable: an automation changes things with no thread behind it, and that is still an
  -- action somebody is entitled to see and reverse.
  thread_id       uuid,
  message_id      uuid,

  tool            text not null,
  -- What changed, in the words the operator reads: "Changed the pipeline stages".
  summary         text not null,
  -- The agent's own reason, carried from the turn. Null when it gave none, which is itself
  -- worth seeing on the card rather than filling in with something plausible.
  reason          text,

  before_state    jsonb,
  after_state     jsonb,

  -- Who asked. The agent acts for a seat, never on its own account, and an action with no
  -- person behind it is the one people are actually afraid of.
  actor_user_id   uuid,

  undone_at       timestamptz,
  undone_by       uuid,
  created_at      timestamptz not null default now()
);

-- The card, the list, and the undo all read by workspace and recency.
create index if not exists agent_actions_workspace_idx
  on public.agent_actions (workspace_id, created_at desc);

-- Rendering a message's actions is a lookup by message. Partial: most rows have one.
create index if not exists agent_actions_message_idx
  on public.agent_actions (message_id) where message_id is not null;
