-- ─────────────────────────────────────────────────────────────────────────────
-- Per-workspace IANA timezone (e.g. 'America/New_York') for resolving due-date
-- phrases ("by Friday", "end of month") in the WORKSPACE's civil time instead
-- of the deployment-wide NOUS_DEFAULT_TIMEZONE / UTC fallback. This is a
-- write-path fix: a due date resolved in the wrong zone is stored as fact in
-- claims and stays wrong even after the code is fixed.
--
-- Captured from the founder's browser (Intl.DateTimeFormat) at onboarding,
-- editable later in Settings. Nullable on purpose: workspaces created before
-- this migration, or via paths that don't capture it, keep the env/UTC
-- fallback until someone sets it.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS timezone TEXT;
