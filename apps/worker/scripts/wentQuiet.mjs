// On demand (GET-1028): which open deals went quiet, and close them with --write. The nightly job
// runs the same check at 03:20 UTC.
//
//   node apps/worker/scripts/wentQuiet.mjs [--workspace=UUID] [--write]
import { runWentQuiet } from '../src/workers/wentQuiet.mjs';

const argv = process.argv.slice(2);
const workspaceId = (argv.find(a => a.startsWith('--workspace=')) || '').split('=')[1] || null;
await runWentQuiet({ workspaceId, dryRun: !argv.includes('--write') });
