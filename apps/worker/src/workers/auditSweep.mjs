// Audit sweep — run the data audit for every workspace, nightly, and alert on what
// broke since yesterday.
//
// This is what turns `nous audit` from a command you have to REMEMBER to run into a
// system that watches itself. The failure the audit exists to catch is the invisible
// one — a connector whose token expired, so nothing errors, the app looks fine, and
// every answer quietly goes stale until someone walks into a meeting believing an
// account is cold. A command that surfaces that only when you type it is itself
// invisible until you type it. This closes that gap: the audit runs on its own, and
// the moment a check regresses, it says so in the workspace log where the app shows it.
//
// It runs the SAME runAudit the CLI and the API route run — imported, not reimplemented
// — so the nightly alert can never disagree with what `nous audit` prints. The file is
// pure (it takes a supabase client and a workspace id, nothing else), which is why the
// worker can import it across apps without dragging anything along.
//
// Alerting is deliberately quiet:
//   · Only NEW findings alert. A snapshot records the finding keys; the next run alerts
//     only on keys that weren't there before. A connector that's been dead for a week
//     alerts once, the night it died, not every night after.
//   · Only HIGH severity alerts individually (the dead-connector case). Slower decay
//     (freshness, resolution) shows up as a health drop, which alerts once as a summary.
//   · The first snapshot for a workspace is a silent baseline — pre-existing issues are
//     what `nous audit` is for, not a wall of alerts the first night.

// Single source of truth. The CLI answer, the API answer, and this alert are the same
// runAudit — it lives in @nous/core (packages/core/src/audit.mjs) precisely so both the
// API image and the worker image, which each carry core but not each other, run the exact
// same function. Mirroring 570 lines here would let the alert and the command drift.
import { getSupabaseClient, runAudit } from '@nous/core';

// A health drop this large alerts as a summary even when no single new high-severity
// finding explains it — i.e. a check degraded sharply rather than a connector dying.
const HEALTH_DROP_ALERT = 15;

// Stable across nights, so "is this the same problem as yesterday?" has an answer.
// A dead connector is keyed by its source (the title carries a day count that changes);
// every other check emits at most one aggregate finding, so its check name is enough.
function findingKey(f) {
  if (f.check === 'arriving' && f.subjects?.[0]?.source) return `arriving:${f.subjects[0].source}`;
  return f.check;
}

// Only workspaces that have connected a continuous source — the audit is meaningful
// there, and this skips sweeping empty workspaces every night.
async function connectedWorkspaceIds(supabase) {
  const ids = new Set();
  const [{ data: conns }, { data: li }] = await Promise.all([
    supabase.from('workflow_provider_connections').select('workspace_id'),
    supabase.from('workspace_linkedin_connections').select('workspace_id'),
  ]);
  for (const c of conns || []) ids.add(c.workspace_id);
  for (const c of li || []) ids.add(c.workspace_id);
  return [...ids];
}

async function alert(supabase, workspaceId, summary, metadata) {
  await supabase.from('workspace_system_log').insert({
    workspace_id: workspaceId,
    source: 'audit',
    event_type: 'audit_regression',
    summary,
    metadata,
    billable_ops: 0,
    occurred_at: new Date().toISOString(),
  });
}

async function sweepWorkspace(supabase, workspaceId) {
  const audit = await runAudit(supabase, workspaceId);
  const keys = audit.findings.map(findingKey);
  const high = audit.findings.filter(f => f.severity === 'high');

  // The previous snapshot, read BEFORE we insert tonight's.
  const { data: prevRows } = await supabase
    .from('workspace_audit_snapshots')
    .select('health, finding_keys')
    .eq('workspace_id', workspaceId)
    .order('checked_at', { ascending: false })
    .limit(1);
  const prev = prevRows?.[0] || null;

  await supabase.from('workspace_audit_snapshots').insert({
    workspace_id: workspaceId,
    health:       audit.health,
    checks:       audit.checks.map(c => ({ key: c.key, pct: c.pct })),
    finding_keys: keys,
    high_count:   high.length,
    failing:      audit.failing,
  });

  // First snapshot is a baseline — nothing to compare against, so nothing to alert.
  if (!prev) return 0;

  const prevKeys = new Set(prev.finding_keys || []);
  const newHigh = high.filter(f => !prevKeys.has(findingKey(f)));

  let alerts = 0;
  for (const f of newHigh) {
    await alert(supabase, workspaceId, `${f.title}. ${f.fix}`, {
      check: f.check, severity: f.severity, health: audit.health, key: findingKey(f),
    });
    alerts++;
  }

  // A sharp overall drop with no new high-severity finding to explain it — one summary,
  // pointing back at the command. (When new high findings DID fire, they already explain
  // the drop, so we don't double-report.)
  const drop = (prev.health ?? 100) - audit.health;
  if (drop >= HEALTH_DROP_ALERT && newHigh.length === 0) {
    await alert(supabase, workspaceId,
      `Graph health dropped ${prev.health}% → ${audit.health}%. Run \`nous audit\` to see what changed.`,
      { health: audit.health, prev_health: prev.health });
    alerts++;
  }

  return alerts;
}

export async function runAuditSweep() {
  const supabase = getSupabaseClient();
  const workspaces = await connectedWorkspaceIds(supabase);
  console.log(`[AUDIT_SWEEP] auditing ${workspaces.length} workspace(s)`);

  let alerted = 0;
  for (const workspaceId of workspaces) {
    try {
      alerted += await sweepWorkspace(supabase, workspaceId);
    } catch (err) {
      // One workspace failing must not stop the sweep for the rest.
      console.error(`[AUDIT_SWEEP] workspace ${workspaceId} failed:`, err.message);
    }
  }
  console.log(`[AUDIT_SWEEP] done — ${alerted} regression alert(s) written`);
}
