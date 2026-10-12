-- What the operator asked us to write once their backfill lands.
--
-- The agent asks at the end of the welcome conversation; the backfill finishes minutes or
-- hours later, in another process. Without somewhere to put the answer the question was
-- theatre — generateOnboardingReports wrote a fixed set regardless of what they picked.
--
-- Keys are report keys ('revenue-report', 'win-loss', 'personal-read'). An empty array is a
-- real answer meaning "write nothing"; NULL means nobody has been asked yet, and those are
-- different states — a workspace that declined must not be re-offered as if it never chose.
alter table public.workspaces
  add column if not exists onboarding_reports jsonb;

alter table public.workspaces
  add column if not exists onboarding_reports_chosen_at timestamptz;

comment on column public.workspaces.onboarding_reports is
  'Report keys the operator chose during onboarding, written when the backfill completes. NULL = never asked; [] = asked and declined.';
