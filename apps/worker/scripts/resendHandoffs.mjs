// Re-send documents an automation already wrote, at a given moment — no rewrite, no new run.
// Recipients are read from the automation when each one goes out, so people added to its
// To/Cc since the first send receive it too.
//
//   node apps/worker/scripts/resendHandoffs.mjs --ws <id> --automation <id> --docs <id,id,…> [--at <ISO>]
//
// --at waits until then, so run it as a standalone container a worker redeploy cannot kill:
//   docker run -d --name resend-handoffs --env-file nous.env -e NODE_ENV=production \
//     --network <compose network> -w /app nous-worker:local node apps/worker/scripts/resendHandoffs.mjs …
import { getSupabaseClient, resendAutomationDocument } from '@nous/core';

const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const WS = arg('--ws');
const AUTOMATION = arg('--automation');
const DOCS = (arg('--docs') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const AT = arg('--at');
if (!WS || !AUTOMATION || !DOCS.length) {
  console.error('usage: --ws <id> --automation <id> --docs <id,id,…> [--at <ISO>]');
  process.exit(2);
}

if (AT) {
  const wait = new Date(AT).getTime() - Date.now();
  if (Number.isNaN(wait)) { console.error(`--at is not a date: ${AT}`); process.exit(2); }
  console.log(`[resend] ${DOCS.length} document(s) at ${new Date(AT).toISOString()} (in ${Math.round(wait / 60000)} min)`);
  // setTimeout caps near 24.8 days; a resend is hours away, but wait in steps anyway.
  while (Date.now() < new Date(AT).getTime()) {
    await new Promise(r => setTimeout(r, Math.min(60_000, new Date(AT).getTime() - Date.now())));
  }
}

const supabase = getSupabaseClient();
let failed = 0;
for (const id of DOCS) {
  try {
    const { delivered, reason } = await resendAutomationDocument(supabase, WS, { automationId: AUTOMATION, documentId: id });
    console.log(`[resend] ${id} → ${delivered ?? `not sent (${reason ?? 'no destination'})`}`);
    if (!delivered) failed++;
  } catch (err) {
    failed++;
    console.error(`[resend] ${id} failed:`, err?.message ?? err);
  }
}
console.log(`[resend] done — ${DOCS.length - failed} sent, ${failed} not`);
process.exit(failed ? 1 : 0);
