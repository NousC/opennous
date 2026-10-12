-- Ops-limit warning emails — the once-per-period send log.
--
-- Phase 3 of ops enforcement: proactive emails (in-app banners only reach people
-- who open the app). A team gets at most ONE email of each kind per billing
-- period: 'warn80' (hit 80%), 'over_limit' (crossed 100%, grace started),
-- 'grace_expiring' (grace window ends within ~a day).
--
-- The api's internal sweep endpoint reserves a send by inserting here (unique on
-- team+kind+period); a duplicate-key error means "already sent this period, skip".
-- period_start anchors to the billing period so it naturally resets each month.

CREATE TABLE IF NOT EXISTS team_ops_email_log (
  team_id      uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind         text NOT NULL,        -- 'warn80' | 'over_limit' | 'grace_expiring'
  period_start timestamptz NOT NULL, -- the billing period this send belongs to
  sent_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, kind, period_start)
);

ALTER TABLE team_ops_email_log ENABLE ROW LEVEL SECURITY;
