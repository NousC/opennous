-- Which conversations were read: a claim cites them in supporting_observation_ids.
--
-- Billing counts one credit per conversation read (GET-510), and the Activity ledger shows the
-- same thing, both by asking "which of these calls and meetings does any claim cite?" — an
-- array-overlap query. With no index on the array each one is a scan of the workspace's claims
-- (~3s on a large workspace), and a month of calls and meetings needs many of them. A GIN index turns
-- each into an index lookup.
--
-- CONCURRENTLY, so the table stays writable while it builds. Run on its own, not inside a
-- transaction (the SQL editor runs a single statement like this one outside one).

create index concurrently if not exists claims_supporting_obs_gin
  on public.claims using gin (supporting_observation_ids);
