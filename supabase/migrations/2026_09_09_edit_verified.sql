-- Whether the accepted-vs-edited label was actually CHECKED (GET-68).
--
-- `proposeDecision` only stores a proposal_hash when the caller passes the drafted body, and
-- the skill guidance never asked for one. So plugin decisions carried no hash, the comparison
-- in recordVerdict was skipped, and the verdict fell through to its 'accepted' default —
-- reporting 100% sent-as-drafted no matter how much a human rewrote.
--
-- The guidance is fixed alongside this. But a default that silently means "we did not check"
-- is what let the bug hide, so the state is now explicit rather than implied: 'accepted' means
-- the human acted on it, and edit_verified says whether we were in a position to know if they
-- changed it first. Rates computed over unverified rows are meaningless and are excluded.
--
-- Additive: one column with a false default, which is the correct reading of every row
-- written before this landed.

alter table public.ri_decisions
  add column if not exists edit_verified boolean not null default false;

create index if not exists ri_decisions_edit_verified_idx
  on public.ri_decisions (workspace_id, edit_verified, verdict);
