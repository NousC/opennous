// What each tool does to the workspace, for MCP clients (GET-1061). A client asks before a write
// only if the tool says it writes, so this is what makes that prompt appear. Tools that both read
// and write (tasks, rules, webhooks, rev_plays, pages) stay visible to a read-only grant: their reads work,
// and the API refuses the rest. A tool not listed here is assumed to write.

const READ = { readOnlyHint: true };
const ADDS = { readOnlyHint: false, destructiveHint: false };
const OVERWRITES = { readOnlyHint: false, destructiveHint: true };

export const TOOL_HINTS = {
  whoami: READ, find: READ, get_context: READ, query: READ, attention: READ, get_insights: READ,
  get_account: READ, deals: READ, read_page: READ, read_intelligence: READ, my_desk: READ,
  score: ADDS, add_note: ADDS, enrich: ADDS, record: ADDS, record_insight: ADDS, record_closed_deals: ADDS,
  set_icp: OVERWRITES, save_page: OVERWRITES, documents: OVERWRITES, assign: OVERWRITES, changes: OVERWRITES,
  tasks: ADDS, pages: OVERWRITES, rules: OVERWRITES, webhooks: OVERWRITES, rev_plays: OVERWRITES,
};

/** Tools with nothing for a read-only grant to do, so tools/list leaves them out. */
export const WRITE_ONLY_TOOLS = new Set([
  'add_note', 'enrich', 'record', 'record_insight', 'record_closed_deals', 'set_icp', 'save_page',
]);

export const toolHints = (name) => TOOL_HINTS[name] ?? { readOnlyHint: false };

/** Is the calling key read-only? A failed check hides nothing: the API still refuses the write. */
export async function keyIsReadOnly(whoami, opts) {
  return (await keyProfile(whoami, opts)).readOnly;
}

// What a rep's agent has no use for (GET-1121): how the company scores, and where its events go. A
// clean list only: the API is the boundary. set_icp and record_closed_deals answer a member 403, and
// a member's webhook is held to their own book (refuseTeamFeedToMember).
export const OPERATOR_TOOLS = new Set(['set_icp', 'record_closed_deals', 'webhooks', 'assign', 'changes']);

/** Who the key is, for what tools/list offers. A failed or slow check hides nothing. */
export async function keyProfile(whoami, { timeoutMs = 3000 } = {}) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    const you = (await Promise.race([whoami(), late]))?.you;
    return { readOnly: you?.capability === 'read_only', member: you?.scope === 'member' };
  } catch { return { readOnly: false, member: false }; }
  finally { clearTimeout(timer); }
}

/** Does this JSON-RPC body ask for the tool list? */
export function wantsToolList(body) {
  return (Array.isArray(body) ? body : [body]).some((m) => m?.method === 'tools/list');
}
