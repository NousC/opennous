// Revenue Intelligence Engine — contracts and shared constants.
//
// The whole engine is these two registered object types plus a generic runner for
// each. Adding a new behavior, observation, or recommendation is adding one object
// to a registry — never new plumbing. See product/revenue-intelligence-engine.md.
//
// A BehaviorExtractor turns the graph into typed, evidence-linked behaviors:
//   {
//     key: 'deal.stakeholder_count',
//     version: 1,                       // bump to force re-extraction / backfill
//     subjectType: 'deal',
//     async extract(ctx) -> Behavior[]  // pure fn of the graph at time T
//   }
//
// A LearningJob owns one question in one category. It LEARNS (writes versioned
// observations) and RECOMMENDS (applies its knowledge to live subjects):
//   {
//     key: 'pipeline.multithreading',
//     category: 'pipeline',
//     type: 'comparative',
//     cadence: 'nightly' | 'weekly' | 'monthly',
//     question: 'Do more stakeholders raise win rate?',
//     async learn(ctx) -> ObservationResult[]
//     async recommend(ctx) -> RecommendationDraft[]
//   }
//
// ctx = { supabase, workspaceId, db }  — db is the helper layer in db.mjs.

export const CATEGORIES = [
  'outbound', 'pipeline', 'meeting', 'signals', 'journey', 'hygiene', 'leakage', 'playbook', 'objection',
];
export const JOB_TYPES = ['correlational', 'comparative', 'deterministic', 'curation'];
export const CADENCES = ['nightly', 'weekly', 'monthly'];
export const CONFIDENCE = ['learning', 'low', 'medium', 'high'];

// Below MIN_SAMPLE an observation is never surfaced — it reads "learning, not enough
// data yet" rather than inventing a number. Above it, confidence climbs with N. A
// job may override (a deterministic rule is 'high' at any N; a comparative job gates
// on its baseline size). This is the honest-at-small-N discipline.
export const MIN_SAMPLE = 8;

export function confidenceForSample(n) {
  if (!n || n < MIN_SAMPLE) return 'learning';
  if (n < 20) return 'low';
  if (n < 50) return 'medium';
  return 'high';
}

// Surfaceable = anything past the learning gate.
export function isActive(confidence) {
  return confidence && confidence !== 'learning';
}
