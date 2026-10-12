-- Call pages (GET-236): every sales call becomes a page in Pages, scored 1–10.
--
-- Three changes, all idempotent:
--   1. documents may hold a `call` page.
--   2. call_scorecards keeps the page text from the same review pass (summary, verdict, went
--      well, improve), what kind of call it was, and the page it produced.
--   3. The score scale moves from 0–100 to 1–10. Existing scorecards are rescaled in place so
--      every reader (Coaching, get_context's LAST CALL SCORE) sees one scale.

-- 1. The `call` kind.
alter table public.documents drop constraint if exists documents_kind_check;
alter table public.documents add constraint documents_kind_check
  check (kind in ('brief', 'plan', 'report', 'meeting_brief', 'objection_prep', 'call'));

-- 2. The page text and the page.
alter table public.call_scorecards add column if not exists call_type   text;
alter table public.call_scorecards add column if not exists summary     text;
alter table public.call_scorecards add column if not exists verdict     text;
alter table public.call_scorecards add column if not exists went_well   text;
alter table public.call_scorecards add column if not exists improve     text;
alter table public.call_scorecards add column if not exists document_id uuid
  references public.documents(id) on delete set null;

-- 3. 0–100 → 1–10. Guarded on the column type, so a second run changes nothing.
do $$
begin
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'call_scorecards' and column_name = 'overall') = 'integer' then
    alter table public.call_scorecards
      alter column overall type numeric(3,1) using round(overall / 10.0, 1);

    update public.call_scorecards c
       set scores = coalesce((
             select jsonb_agg(e.elem || jsonb_build_object('score', round(coalesce((e.elem->>'score')::numeric, 0) / 10.0)) order by e.ord)
               from jsonb_array_elements(c.scores) with ordinality as e(elem, ord)
           ), '[]'::jsonb);
  end if;
end $$;

comment on column public.call_scorecards.overall is 'Weighted overall, 1–10 to one decimal (was 0–100 before 2026-09-14).';
comment on column public.call_scorecards.document_id is 'The call page in Pages this review produced (GET-236).';
