-- Insights — the workspace's self-knowledge, learned from calls.
--
-- Mirror image of foundations (formerly playbooks): a foundation is authored by
-- the user and mirrored INTO Nous; an insight is authored by Nous (extracted from
-- call transcripts) and can be mirrored OUT to the user's repo. One doc per
-- (workspace, category). The four categories map to the four Insights docs in the
-- Vault: product, positioning, market, buyer.

CREATE TABLE IF NOT EXISTS public.insights (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    category text NOT NULL,
    title text NOT NULL,
    body_md text DEFAULT ''::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT insights_pkey PRIMARY KEY (id),
    CONSTRAINT insights_category_check CHECK ((category = ANY (ARRAY['product'::text, 'positioning'::text, 'market'::text, 'buyer'::text]))),
    CONSTRAINT insights_workspace_id_category_key UNIQUE (workspace_id, category)
);

CREATE INDEX IF NOT EXISTS insights_workspace_idx ON public.insights USING btree (workspace_id);

ALTER TABLE public.insights ENABLE ROW LEVEL SECURITY;
