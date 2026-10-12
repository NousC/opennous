-- Which deal an activity was about.
--
-- Why: an observation points at exactly one entity (a person), while a call or an email
-- can be about a specific deal on that person's account. HubSpot carries that link as an
-- engagement → deal association; the sync fetched it for a year and filed it into
-- observations.raw.deal_ids where nothing could read it. This table makes the link a row:
-- indexable for a per-deal timeline, and carrying WHO made the attribution — the CRM
-- (mirrored), a human (the CRM agent's "which deal?" answer), or an inference — with a
-- confidence, so a deal's timeline can say how it knows.
--
-- Safe to run more than once: every statement is guarded.

CREATE TABLE IF NOT EXISTS public.observation_deals (
    workspace_id    uuid        NOT NULL,
    observation_id  uuid        NOT NULL,
    deal_entity_id  uuid        NOT NULL,
    source          text        NOT NULL,
    confidence      real        DEFAULT 1.0 NOT NULL,
    decided_by      uuid,
    created_at      timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observation_deals_pkey') THEN
    ALTER TABLE ONLY public.observation_deals
      ADD CONSTRAINT observation_deals_pkey PRIMARY KEY (observation_id, deal_entity_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observation_deals_source_check') THEN
    ALTER TABLE ONLY public.observation_deals
      ADD CONSTRAINT observation_deals_source_check CHECK (source = ANY (ARRAY['crm'::text, 'human'::text, 'inferred'::text]));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observation_deals_observation_id_fkey') THEN
    ALTER TABLE ONLY public.observation_deals
      ADD CONSTRAINT observation_deals_observation_id_fkey
      FOREIGN KEY (observation_id) REFERENCES public.observations(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observation_deals_deal_entity_id_fkey') THEN
    ALTER TABLE ONLY public.observation_deals
      ADD CONSTRAINT observation_deals_deal_entity_id_fkey
      FOREIGN KEY (deal_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Tenant rows: only the service role reads them (GET-247). RLS on with no policy, and no
-- grants to the browser roles, so the public key can never reach another workspace's links.
ALTER TABLE public.observation_deals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.observation_deals FROM anon, authenticated;

-- The per-deal timeline read: "everything filed against this deal, newest first".
CREATE INDEX IF NOT EXISTS idx_observation_deals_deal ON public.observation_deals USING btree (workspace_id, deal_entity_id, created_at DESC);
