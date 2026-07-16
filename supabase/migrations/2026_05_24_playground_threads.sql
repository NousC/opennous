-- Playground threads — the per-user chat history for the /playground page.
--
-- The Playground is a chat-with-your-context demo: the user types a question
-- ("What do we know about Arnold?"), the agent picks the right Nous verbs to
-- call, and the right-hand panel surfaces every API call it made. Threads
-- persist across sessions so the user can come back to past experiments.
--
-- Tool-call traces live on the message row as JSONB so we can render the
-- right-hand context panel from the same fetch that loads the conversation.

create table if not exists playground_threads (
  id            uuid        primary key default gen_random_uuid(),
  workspace_id  uuid        not null references workspaces(id) on delete cascade,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  title         text,                              -- first user message (truncated) or "New chat"
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Thread list query: most-recently-touched first, scoped to the (workspace, user).
create index if not exists playground_threads_workspace_user_updated_idx
  on playground_threads (workspace_id, user_id, updated_at desc);

create table if not exists playground_messages (
  id          uuid        primary key default gen_random_uuid(),
  thread_id   uuid        not null references playground_threads(id) on delete cascade,
  role        text        not null check (role in ('user', 'assistant')),
  content     text        not null default '',     -- streamed assistant text accumulates here
  -- Tool calls made WHILE building this assistant message. Shape per element:
  -- { name, input, output, duration_ms, status: 'ok'|'error', error? }
  -- Stays null for user messages.
  tool_calls  jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists playground_messages_thread_created_idx
  on playground_messages (thread_id, created_at);

-- Keep the thread's updated_at in sync so the sidebar always sorts correctly.
create or replace function bump_playground_thread_updated() returns trigger
language plpgsql as $$
begin
  update playground_threads
    set updated_at = now()
    where id = new.thread_id;
  return new;
end
$$;

drop trigger if exists trg_playground_messages_bump_thread on playground_messages;
create trigger trg_playground_messages_bump_thread
  after insert on playground_messages
  for each row execute function bump_playground_thread_updated();
