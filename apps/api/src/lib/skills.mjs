// Skills — loading the procedures the agent knows.
//
// A skill is a procedure written in prose. The agent carries every skill's
// DESCRIPTION on every turn (one line each, a few hundred tokens for the whole
// library) and pulls the BODY only when it decides the skill applies. That's the
// progressive disclosure a SKILL.md gets in Claude Code, and it's why a library
// can grow to fifty skills without the prompt growing with it.
//
// Built-ins are files in this repo (./skills/<name>/SKILL.md), seeded into
// workspace_skills on boot. Git is the source of truth; the table is the runtime.
// A workspace can also write its own skills into the same table — same loader,
// same catalog, same execution path — which is the whole reason skills live in
// the DB rather than only on disk.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

// ─── The file format ────────────────────────────────────────────────────────
//
// Identical to a Claude Code SKILL.md: a YAML front-matter block, then the
// procedure as markdown. We read the handful of keys we act on and ignore the
// rest, so a skill file can carry notes for a human without breaking the parse.

/** Parse `---\nkey: value\n---\nbody`. Returns { meta, body }. */
export function parseSkillFile(text) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(String(text));
  if (!m) return { meta: {}, body: String(text).trim() };

  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;                    // continuation / comment / nested — not ours
    const key = kv[1].trim();
    let raw = kv[2].trim();
    if (!raw) continue;
    raw = raw.replace(/^["'](.*)["']$/s, '$1');

    // `[a, b]` — the only list form we use, because front-matter that needs a
    // real YAML parser is front-matter that's too clever.
    if (/^\[.*\]$/.test(raw)) {
      meta[key] = raw.slice(1, -1).split(',').map(s => s.trim().replace(/^["'](.*)["']$/, '$1')).filter(Boolean);
    } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
      meta[key] = Number(raw);
    } else {
      meta[key] = raw;
    }
  }
  return { meta, body: (m[2] ?? '').trim() };
}

// ─── Seeding the built-ins ──────────────────────────────────────────────────

/**
 * Read every ./skills/<name>/SKILL.md and mirror it into workspace_skills as a
 * built-in (workspace_id NULL). Runs on boot, so shipping a skill is shipping a
 * file. Best-effort: a bad skill file must never stop the API from starting.
 */
export async function seedBuiltinSkills(supabase) {
  let dirs;
  try {
    dirs = (await readdir(SKILLS_DIR, { withFileTypes: true }))
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return 0;   // no skills directory yet
  }

  let seeded = 0;
  for (const dir of dirs) {
    try {
      const { meta, body } = parseSkillFile(await readFile(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8'));
      const name = String(meta.name ?? dir).trim();
      if (!name || !meta.description || !body) {
        console.warn(`[SKILLS] ${dir}: needs a name, a description and a body — skipped`);
        continue;
      }
      const row = {
        workspace_id:       null,
        name,
        // Two different jobs, deliberately two fields. `description` is what the
        // MODEL reads to decide whether the skill applies — it needs the "use for
        // X, not Y" detail or it picks wrong. `summary` is what a PERSON reads on
        // the card. Shortening the description to make a card look tidy would
        // quietly make the agent worse at choosing.
        description:        String(meta.description),
        summary:            meta.summary ? String(meta.summary) : null,
        body,
        // The department this skill serves (AEs, GTM, RevOps…) — the chip on the card.
        category:           meta.category ? String(meta.category) : null,
        requires_providers: toList(meta['requires-providers']),
        allowed_tools:      toList(meta['allowed-tools']),
        est_cost_usd:       typeof meta['est-cost-usd'] === 'number' ? meta['est-cost-usd'] : null,
        is_builtin:         true,
      };

      // Upsert by hand: ON CONFLICT can't infer the partial unique index that
      // keeps built-in names unique (the one with `WHERE workspace_id IS NULL`).
      const { data: existing } = await supabase
        .from('workspace_skills')
        .select('id').is('workspace_id', null).eq('name', name).maybeSingle();

      const { error } = existing
        ? await supabase.from('workspace_skills').update(row).eq('id', existing.id)
        : await supabase.from('workspace_skills').insert(row);
      if (error) throw error;
      seeded++;
    } catch (err) {
      console.warn(`[SKILLS] ${dir}: ${err.message}`);
    }
  }
  if (seeded) console.log(`[SKILLS] ${seeded} built-in skill${seeded === 1 ? '' : 's'} loaded`);
  return seeded;
}

const toList = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []);

// ─── What this workspace knows how to do ────────────────────────────────────

/**
 * Every skill available to a workspace: the Nous built-ins plus its own. A
 * workspace skill with the same name as a built-in SHADOWS it — that's how a team
 * takes our meeting-brief and makes it theirs, without us needing a fork button.
 */
export async function listSkills(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('workspace_skills')
    .select('id, workspace_id, name, description, summary, body, category, requires_providers, allowed_tools, est_cost_usd, is_builtin')
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .eq('enabled', true);
  if (error) throw error;

  const byName = new Map();
  for (const s of data ?? []) {
    const held = byName.get(s.name);
    // The workspace's own always wins over the built-in it shares a name with.
    if (!held || (held.workspace_id === null && s.workspace_id !== null)) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The lines that ride in the system prompt on every turn — name, when to use it,
 * and what it costs. This is the ONLY part of a skill the model sees until it
 * asks for one, so it has to carry enough for the model to choose correctly.
 */
export function skillCatalog(skills) {
  if (!skills?.length) return '';
  const lines = skills.map(s => {
    const cost = s.est_cost_usd > 0 ? ` [costs ~$${Number(s.est_cost_usd).toFixed(2)} per run]` : '';
    return `  • ${s.name} — ${s.description}${cost}`;
  });
  return [
    '',
    '--- SKILLS ---',
    'Procedures you know. Each one is a way of doing a job properly, written down. When a request matches one, call `load_skill` with its name and FOLLOW THE PROCEDURE IT GIVES YOU — do not improvise your own version of a job we have already worked out how to do.',
    '',
    ...lines,
    '',
    'A skill that costs money never runs on a guess: tell the user what it will cost, and wait for them to say go.',
  ].join('\n');
}

/**
 * Which of the integrations a skill needs are actually connected here. The point
 * is an honest failure: an agent that says "connect Apify in Integrations" is
 * useful, one that dies mid-procedure is not.
 */
export async function missingProviders(supabase, workspaceId, providers) {
  const want = toList(providers);
  if (!want.length) return [];

  const { data: rows } = await supabase
    .from('workflow_providers')
    .select('id, name, display_name')
    .in('name', want);
  if (!rows?.length) return want;

  const { data: conns } = await supabase
    .from('workflow_provider_connections')
    .select('provider_id')
    .eq('workspace_id', workspaceId)
    .eq('is_verified', true)
    .in('provider_id', rows.map(r => r.id));

  const connected = new Set((conns ?? []).map(c => c.provider_id));
  return rows.filter(r => !connected.has(r.id)).map(r => r.display_name || r.name);
}
