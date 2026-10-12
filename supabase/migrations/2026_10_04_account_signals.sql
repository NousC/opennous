-- Account signals (GET-686).
--
-- Extraction already files what was said on calls and emails as facts (claims `note.*` with a
-- category, and `action_item.*`): objections, competitors, stakeholders, budget, expansion,
-- churn risk, next steps. Nothing happened when one landed. This turns the moment a fact
-- APPEARS, or CHANGES in a way that matters, into a signal: one row per account, with the
-- quote, the speaker and where it was said. A worker then sends it on — webhooks, automations.
--
-- A trigger on claims, not code in each writer: facts are written by call and email
-- extraction, the agent's record tool, imports and reconciliation. The trigger sees them all.
--
-- What becomes a signal:
--   objection        new and open                       objection_raised
--                    open -> resolved / addressed       objection_resolved
--   competitor       new                                competitor_mentioned (competitor_evaluating when so)
--                    -> evaluating                      competitor_evaluating
--   authority        new, a buying role                 stakeholder_identified
--   staff_change     new, joined / left                 stakeholder_joined / stakeholder_left
--   budget           new                                budget_discussed
--   buying_signal    new                                buying_signal
--   expansion_signal new, asked / considering          expansion_signal
--                    new, declined                      expansion_declined
--   risk_signal      new                                churn_risk
--   action_item      new, open                          next_step
--
-- Safe to run more than once. Existing facts are not replayed: only writes after this runs.

CREATE TABLE IF NOT EXISTS public.account_signals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- The person or company the fact is about, and the account it rolls up to.
  entity_id          uuid NOT NULL,
  account_id         uuid,
  kind               text NOT NULL,
  claim_property     text NOT NULL,
  title              text,
  content            text,
  quote              text,
  speaker            text,
  source_ref         text,
  -- The fact's own detail: stance, status, role, change, severity, product, owner, due.
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Readable by the whole team. Decided by the worker with the message-privacy rules (GET-253):
  -- a fact derived from one person's private mail is stored, but never sent to a webhook or
  -- used by an automation. Null until checked.
  team_readable      boolean,
  -- When it was said (the source conversation), not when we read it.
  occurred_at        timestamptz,
  detected_at        timestamptz NOT NULL DEFAULT now(),
  -- Set by the worker once it has been sent on.
  processed_at       timestamptz,
  dedupe_key         text NOT NULL,
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS account_signals_account ON public.account_signals (workspace_id, account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS account_signals_pending ON public.account_signals (detected_at) WHERE processed_at IS NULL;
ALTER TABLE public.account_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_signals_select ON public.account_signals;
CREATE POLICY account_signals_select ON public.account_signals
  FOR SELECT USING (is_workspace_member(workspace_id));

-- Which signal, if any, this fact write is.
CREATE OR REPLACE FUNCTION public.account_signal_kind(prop text, old_v jsonb, new_v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  cat text := new_v->>'category';
  m jsonb := coalesce(new_v->'metadata', '{}'::jsonb);
  om jsonb := coalesce(old_v->'metadata', '{}'::jsonb);
  fresh boolean := old_v IS NULL;
BEGIN
  IF prop LIKE 'action_item.%' THEN
    RETURN CASE WHEN fresh AND coalesce(new_v->>'status', 'open') = 'open' THEN 'next_step' END;
  END IF;
  IF prop NOT LIKE 'note.%' THEN RETURN NULL; END IF;

  IF cat = 'objection' THEN
    IF fresh AND coalesce(m->>'status', 'open') = 'open' THEN RETURN 'objection_raised'; END IF;
    IF NOT fresh AND coalesce(om->>'status', 'open') = 'open' AND m->>'status' IN ('resolved', 'addressed') THEN RETURN 'objection_resolved'; END IF;
  ELSIF cat = 'competitor' THEN
    IF fresh THEN RETURN CASE WHEN m->>'stance' = 'evaluating' THEN 'competitor_evaluating' ELSE 'competitor_mentioned' END; END IF;
    IF coalesce(om->>'stance', '') <> 'evaluating' AND m->>'stance' = 'evaluating' THEN RETURN 'competitor_evaluating'; END IF;
  ELSIF fresh AND cat = 'authority' AND m->>'role' IN ('champion', 'economic_buyer', 'decision_maker', 'blocker') THEN
    RETURN 'stakeholder_identified';
  ELSIF fresh AND cat = 'staff_change' AND m->>'change' = 'joined' THEN RETURN 'stakeholder_joined';
  ELSIF fresh AND cat = 'staff_change' AND m->>'change' = 'left' THEN RETURN 'stakeholder_left';
  ELSIF fresh AND cat = 'budget' THEN RETURN 'budget_discussed';
  ELSIF fresh AND cat = 'buying_signal' THEN RETURN 'buying_signal';
  ELSIF fresh AND cat = 'expansion_signal' THEN
    RETURN CASE WHEN m->>'stance' = 'declined' THEN 'expansion_declined' ELSE 'expansion_signal' END;
  ELSIF fresh AND cat = 'risk_signal' THEN RETURN 'churn_risk';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.account_signals_from_claims() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k text;
  m jsonb;
  acct uuid;
  etype text;
  said timestamptz;
BEGIN
  IF NEW.invalid_at IS NOT NULL THEN RETURN NULL; END IF;
  -- An update that was invalid before is a fact coming back, not a new one.
  k := public.account_signal_kind(NEW.property,
         CASE WHEN TG_OP = 'UPDATE' AND OLD.invalid_at IS NULL THEN OLD.value END, NEW.value);
  IF k IS NULL THEN RETURN NULL; END IF;
  m := coalesce(NEW.value->'metadata', '{}'::jsonb);

  -- The account: the company itself, or the company the person works at.
  SELECT e.type INTO etype FROM public.entities e WHERE e.id = NEW.entity_id;
  IF etype = 'company' THEN
    acct := NEW.entity_id;
  ELSE
    SELECT r.to_entity_id INTO acct FROM public.relationships r
      WHERE r.workspace_id = NEW.workspace_id AND r.from_entity_id = NEW.entity_id
        AND r.type = 'works_at' AND r.valid_to IS NULL
      ORDER BY r.valid_from DESC NULLS LAST LIMIT 1;
  END IF;

  -- When it was said: the next step's own time, else the conversation the fact came from.
  said := NULLIF(NEW.value->>'occurred_at', '')::timestamptz;
  IF said IS NULL AND (m->>'source_activity_id') ~ '^[0-9a-f-]{36}$' THEN
    SELECT o.observed_at INTO said FROM public.observations o WHERE o.id = (m->>'source_activity_id')::uuid;
  END IF;

  INSERT INTO public.account_signals (
    workspace_id, entity_id, account_id, kind, claim_property, title, content, quote, speaker,
    source_ref, detail, occurred_at, dedupe_key
  ) VALUES (
    NEW.workspace_id, NEW.entity_id, acct, k, NEW.property,
    coalesce(NEW.value->>'label', NEW.value->>'title'),
    coalesce(NEW.value->>'content', NEW.value->>'description', NEW.value->>'title'),
    m->>'quote',
    coalesce(m->>'speaker', NEW.value->>'asked_by'),
    coalesce(m->>'source_ref', NEW.value->>'source_url'),
    jsonb_strip_nulls(jsonb_build_object(
      'stance', m->>'stance', 'status', coalesce(m->>'status', NEW.value->>'status'), 'role', m->>'role',
      'change', m->>'change', 'severity', m->>'severity', 'product', m->>'product',
      'due_at', NEW.value->>'due_at', 'owner', NEW.value->>'owner_kind', 'source', coalesce(m->>'extraction_source', NEW.value->>'source_type'))),
    coalesce(said, now()),
    NEW.property || ':' || k
  ) ON CONFLICT (workspace_id, dedupe_key) DO NOTHING;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS account_signals_from_claims ON public.claims;
CREATE TRIGGER account_signals_from_claims
  AFTER INSERT OR UPDATE OF value, invalid_at ON public.claims
  FOR EACH ROW
  WHEN (NEW.property LIKE 'note.%' OR NEW.property LIKE 'action_item.%')
  EXECUTE FUNCTION public.account_signals_from_claims();
