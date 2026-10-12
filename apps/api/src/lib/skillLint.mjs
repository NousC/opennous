// Skill compatibility linter — the DETECT/VERIFY gate of the import pipeline.
//
// The Nous agent is a TOOL runtime: a fixed set of tools, no shell, no filesystem.
// A skill written for the Claude Code / sandbox runtime (shell + on-disk files) does
// not run here. These deterministic checks catch that mismatch — every failure mode
// we hit bringing a skill over — so a problem is visible before the skill goes live,
// and the GitHub ingest can refuse to import a skill that can't run.
//
// Levels: 'error' = it will not run correctly as-is (blocks auto-import).
//         'warn'  = it will probably run but should be cleaned up.

// `$(...)`, a bare `cat WHOAMI`, or a backticked shell command.
const SHELL_RE = /\$\([^)]*\)|\bcat\s+WHOAMI\b|`[^`]*\b(?:cat|ls|grep|sed|awk|python3?|bash|sh|node)\b[^`]*`/;
// A script the agent would have to execute (no code sandbox here).
const SCRIPTS_RE = /\bscripts\/[A-Za-z0-9_.-]+\.(?:py|sh|js|mjs|ts)\b/;
// A file read by path in the vault/repo tree (not a bundled reference).
const PATH_RE = /\b(?:people|context|content|references|research|strategy|marketing|assets)\/[A-Za-z0-9_.@$(){}\/-]*\.(?:md|py|sh|json|js|ya?ml|csv)\b/g;
// The tools the tool-runtime actually offers (for the empty-allowed_tools heuristic).
const TOOL_HINT_RE = /\b(?:get_icp|get_foundation|read_skill_reference|read_vault_file|search_vault|get_context|get_account|query|attention|verify|record|save_note|calendar|pipeline|campaign_performance|propose_[a-z_]+|ask_user|load_skill|remember_account)\b/;

/**
 * Lint one skill against the runtime it declares.
 *
 * `runtime='tool'` (the default) is the Nous tool runtime — no shell, no files —
 * so shell/scripts/path-reads are errors: the skill won't run as written. But the
 * same skill marked `runtime='sandbox'` is MEANT to run in a container with its
 * folder on disk, so those stop being errors and become the reason it's a sandbox
 * skill. This is the ROUTE-don't-block rule: detection decides the lane, not a veto.
 *
 * @returns {{level:'error'|'warn', code:string, message:string}[]}
 */
export function lintSkill({ name = '', body = '', allowedTools = [], referenceNames = [], builtinNames = [], runtime = 'tool' }) {
  const out = [];
  const add = (level, code, message) => out.push({ level, code, message });
  const uniq = (a) => [...new Set(a)];
  const sandbox = runtime === 'sandbox';

  // Shadows a native skill of the same name — it will silently override it.
  // True in either runtime — a name collision is a name collision.
  if (builtinNames.includes(name)) {
    add('error', 'shadows_builtin', `A built-in skill named "${name}" already exists — this would silently override it for you. Rename it unless you mean to replace the native one.`);
  }

  // Shell, scripts, and on-disk file reads: errors in the tool runtime (nothing to
  // run them), expected in the sandbox (that's what it's for). Only flag for 'tool'.
  if (!sandbox) {
    if (SHELL_RE.test(body)) {
      add('error', 'shell_usage', 'The body uses shell (e.g. `$(cat WHOAMI)` or a backticked command). The Nous tool runtime has no shell — either mark this skill `runtime: sandbox` to run it in a container, or replace file reads with read_skill_reference and drop the shell.');
    }
    if (SCRIPTS_RE.test(body)) {
      add('error', 'scripts_unsupported', 'The body runs a script (scripts/…). The tool runtime has no code sandbox — mark this skill `runtime: sandbox` so it executes in a container, or capture the procedure in prose.');
    }
    const paths = uniq([...body.matchAll(PATH_RE)].map((m) => m[0]));
    if (paths.length) {
      add('warn', 'file_paths', `The body reads files by path (${paths.slice(0, 4).join(', ')}${paths.length > 4 ? `, +${paths.length - 4} more` : ''}). The tool runtime can't open arbitrary paths — attach these as reference files (read_skill_reference), use read_vault_file if they're in the vault, or mark the skill \`runtime: sandbox\`.`);
    }
  }

  // read_skill_reference calls for a reference that isn't attached.
  const called = uniq([...body.matchAll(/read_skill_reference[^\n]*?name\s*=\s*["']([a-z0-9-]+)["']/gi)].map((m) => m[1]));
  const missing = called.filter((n) => !referenceNames.includes(n));
  if (missing.length) {
    add('error', 'missing_reference', `The body calls read_skill_reference for ${missing.join(', ')}, but no reference by that name is attached. Add the reference file(s), or fix the name.`);
  }

  // Uses tools but declares none.
  if (!allowedTools.length && TOOL_HINT_RE.test(body)) {
    add('warn', 'no_tools', 'allowed_tools is empty, but the body uses tools. List the tools the skill needs so it reads as intended (and so a future paywall gate resolves right).');
  }

  // Oversized always-loaded body.
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > 5000) {
    add('warn', 'body_too_long', `The body is ~${words.toLocaleString()} words. Keep it under ~5,000 and move depth into reference files (read_skill_reference), so the skill stays fast to load.`);
  }

  return out;
}

/** True when a skill has an error-level problem (used to gate auto-import). */
export function hasBlockingLint(warnings) {
  return warnings.some((w) => w.level === 'error');
}
