-- One-time guided-tour completion flag, per workspace. Backs the localStorage
-- suppression with server truth so the tour never re-shows on a new browser/device.
-- Idempotent.
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS tour_completed_at timestamptz;
