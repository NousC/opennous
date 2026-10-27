// Strip every production credential from the environment before the extractor loads (GET-1048).
//
// The eval reads with the real extraction code, and that code reaches more than the model when it
// is configured to: the credit gate calls the API (WORKER_INTERNAL_SECRET + API_URL), the model
// door writes llm_usage rows to Supabase (SUPABASE_URL + service key), the duplicate search embeds
// each fact (OPENAI_API_KEY), useleak reports spend (LEAK_KEY). An eval run on a machine with a
// full .env must touch none of it: the database is in memory (extract.mjs), and the only network
// calls are to the models.
//
// What is kept: the model keys and model choices (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, LLM_*,
// EXTRACTION_MODEL, INSIGHT_BOARD_MODEL, EVAL_JUDGE_MODEL, …) and everything not listed here.

export const PRODUCTION_ENV = /^(SUPABASE_|DATABASE_|POSTGRES|PG(HOST|USER|PASSWORD|DATABASE|PORT)$|WORKER_INTERNAL_SECRET$|NOUS_API_INTERNAL_URL$|API_URL$|OPENAI_API_KEY$|SENTRY_|POSTHOG|REDIS|CLERK_|STRIPE_|RESEND|COMPOSIO|UNIPILE|SLACK_|HUBSPOT|GOOGLE_|GMAIL_|FELLOW|GRANOLA|FIREFLIES|EXA_|LEAK_)/;

/** Remove the production keys from `env`. Returns the names removed (never the values). */
export function scrubProductionEnv(env = process.env) {
  const removed = Object.keys(env).filter(k => PRODUCTION_ENV.test(k));
  for (const k of removed) delete env[k];
  return removed;
}
