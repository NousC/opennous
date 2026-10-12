-- Backfill watermark: the timestamp through which this workspace's history has already
-- been pulled. The enricher lower-bounds every scan at max(now - plan_window, this), so a
-- re-run (a reconnect, a credit-resume, a cron) only fetches activity NEWER than the last
-- completed backfill instead of re-scanning the whole window. Internal — no UI. Idempotent.
alter table public.workspaces add column if not exists history_backfilled_at timestamptz;
