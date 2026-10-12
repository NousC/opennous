// Run the automation poll by hand — the same pass the daily cron makes.
//
//   node apps/worker/scripts/runAutomations.mjs [--since-hours 720]
//
// Useful for the first run on a workspace, where "since yesterday" finds nothing because
// the stage changes it should act on happened weeks ago.
import { runAutomationDailyPoll } from '@nous/core';

const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const sinceHours = Number(arg('--since-hours')) || 26;
// --account narrows a run to ONE account, which is how a change to the writer gets tried.
await runAutomationDailyPoll({
  sinceHours,
  onlyAccount: arg('--account'),
  onlyWorkspace: arg('--ws'),
});
console.log('done');
