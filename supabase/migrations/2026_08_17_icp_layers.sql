-- Layered ICP model — tag each scorecard signal with the layer it scores.
--
--   Fit     — who they are (persona, firmographics). Static, readable on sight.
--   Pain    — do they actually have the problem? (fragmented stack, manual CRM…)
--   Intent  — is something happening now? (hiring, momentum, stack change, replies)
--   Ability — can/will they buy & deploy? (maturity, infra) — thin for now.
--
-- The scorer computes a sub-score per layer and a Priority = product of the KNOWN
-- layers. A layer with no fired signal is UNKNOWN (—), never 0 — unknown ≠ low.
-- See product/icp-model-layered-redesign.md and decisions/log.md 2026-08-17.

alter table public.scorecard_signals
  add column if not exists layer text not null default 'fit'
    check (layer in ('fit', 'pain', 'intent', 'ability'));

comment on column public.scorecard_signals.layer is
  'Which ICP layer this signal scores: fit|pain|intent|ability. Drives the per-layer sub-scores and the multiplicative Priority. Default fit; retagged by layerForFeature() at seed time and by the learning loop.';

-- Backfill existing signals from their rule feature. signal-scan emits a fixed set
-- of signal.<class> features (domain, friction, hiring, momentum, stack, intent):
--   friction                     → pain   (operational pain observed on the account)
--   hiring | momentum | stack | intent → intent (timing / in-market behaviour)
--   everything else (personas, firmographics, signal.domain, disqualifiers) stays fit.
update public.scorecard_signals
   set layer = 'pain'
 where rule->>'feature' = 'signal.friction';

update public.scorecard_signals
   set layer = 'intent'
 where rule->>'feature' in ('signal.hiring', 'signal.momentum', 'signal.stack', 'signal.intent');
