// The SKILL.md file format — GET-754. Split out of the agent's skills loader
// (cloud/lib/skills.mjs) because personal-vault sync (lib/personalGithub.mjs) reads a
// member's own skill files with it too, and that runs on every build.

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
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;                    // continuation / comment / nested — not ours
    const key = kv[1].trim();
    let raw = kv[2].trim();

    // Block scalars — `description: >` (fold newlines into spaces) and `description: |`
    // (keep them). The plugin's own skills use `>` for long trigger lines, and reading
    // the marker as the value is how a skill ends up described as ">".
    const block = /^([>|])([+-]?)$/.exec(raw);
    if (block) {
      const collected = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        collected.push(lines[++i].trim());
      }
      const text = block[1] === '|'
        ? collected.join('\n').trim()
        : collected.reduce((acc, l) => (l === '' ? `${acc}\n\n` : acc && !acc.endsWith('\n') ? `${acc} ${l}` : acc + l), '').trim();
      if (text) meta[key] = text;
      continue;
    }

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
