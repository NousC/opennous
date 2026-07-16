// arms.mjs
//
// The two arms. Both run the same Anthropic tool-use loop, same system prompt
// shell, same model, temperature 0, same task. The only difference is the tools
// they are handed and the data those tools return.
//
//   Arm A "reconstruct": RAW tools over the scattered rawView. Duplicates,
//     no joins, no scoring. The agent must stitch context itself every call.
//     This is a COMPETENT baseline: the tools are good and the data is all there,
//     it just is not resolved.
//
//   Arm B "graph": RESOLVED tools over resolvedView. get_context returns one
//     compact resolved account block; query returns resolved blocks across scope.
//
// runArm returns { answerText, inputTokens, outputTokens, latencyMs, toolCalls }.

import Anthropic from '@anthropic-ai/sdk';
import { rawView, resolvedView } from './fixture.mjs';

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT =
  'You are a GTM analyst. Use the tools available to answer the question accurately and concisely. ' +
  'Base every claim on what the tools return. Do not invent facts. When you have enough to answer, ' +
  'stop calling tools and give the final answer.';

const MAX_TOKENS = 1024; // small output budget, same for both arms
const MAX_TURNS = 12; // safety cap on the tool loop

// ---------------------------------------------------------------------------
// Tool schemas + handlers per arm.
// ---------------------------------------------------------------------------

function armATools() {
  const raw = rawView();

  const tools = [
    {
      name: 'search_contacts',
      description:
        'Search raw contact rows across all sources by a text query (matches name, email, title, or account). Returns unresolved rows; the same real person may appear more than once under different identifiers.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Free-text search.' } },
        required: ['query'],
      },
    },
    {
      name: 'get_contact_raw',
      description: 'Get a single raw contact row by its id. Returns exactly what one source recorded; not joined with other sources.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'get_activities',
      description:
        'Get raw activity rows (emails, meeting transcripts, notes). Optionally filter by account name or by a contact email. Activities are keyed by whatever identifier the source used and are NOT joined to a resolved person.',
      input_schema: {
        type: 'object',
        properties: {
          account: { type: 'string', description: 'Optional account name filter.' },
          contactEmail: { type: 'string', description: 'Optional contact email filter.' },
        },
      },
    },
    {
      name: 'get_crm_rows',
      description: 'Get all raw CRM account rows: firmographics and the latest deal stage/amount. No scoring, no intent rollup, no ICP fit.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'get_signals',
      description: 'Get all raw signal rows (intent, hiring, funding, tech). Ungraded and not rolled up into a score.',
      input_schema: { type: 'object', properties: {} },
    },
  ];

  function handle(name, input) {
    const q = (input && input.query ? String(input.query) : '').toLowerCase();
    switch (name) {
      case 'search_contacts': {
        const rows = raw.contacts.filter((c) => {
          const blob = `${c.name} ${c.email || ''} ${c.linkedin || ''} ${c.title} ${c.account || ''}`.toLowerCase();
          return q === '' || blob.includes(q);
        });
        return { rows };
      }
      case 'get_contact_raw': {
        const row = raw.contacts.find((c) => c.id === input.id) || null;
        return { row };
      }
      case 'get_activities': {
        let rows = raw.activities;
        if (input && input.account) {
          const a = String(input.account).toLowerCase();
          rows = rows.filter((r) => (r.account || '').toLowerCase().includes(a));
        }
        if (input && input.contactEmail) {
          const e = String(input.contactEmail).toLowerCase();
          rows = rows.filter((r) => (r.contactEmail || '').toLowerCase() === e);
        }
        return { rows };
      }
      case 'get_crm_rows':
        return { rows: raw.crmRows };
      case 'get_signals':
        return { rows: raw.signals };
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  return { tools, handle };
}

function armBTools() {
  const resolved = resolvedView();

  const tools = [
    {
      name: 'get_context',
      description:
        'Return one compact, resolved account block for a single account: firmographics, precomputed ICP fit, fresh-intent flag, resolved stakeholders (identity already merged, one canonical person even if they appeared under several identifiers), durable facts, recent signals, and the timeline. The intent shapes emphasis but the block is already assembled and scored.',
      input_schema: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'Account name or domain to load.' },
          intent: {
            type: 'string',
            description: 'One of account_review, follow_up, meeting_prep, draft_email. Shapes emphasis.',
          },
        },
        required: ['focus'],
      },
    },
    {
      name: 'query',
      description:
        'Query across resolved accounts. scope "focus" returns the accounts ranked highest to prioritize now (high ICP fit plus fresh intent), already computed. scope "all" returns compact resolved blocks for every account.',
      input_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'One of "focus" or "all".' },
        },
        required: ['scope'],
      },
    },
  ];

  function findAccount(focus) {
    const f = String(focus || '').toLowerCase();
    return (
      resolved.accounts.find((a) => a.name.toLowerCase() === f) ||
      resolved.accounts.find((a) => a.name.toLowerCase().includes(f)) ||
      resolved.accounts.find((a) => (a.domain || '').toLowerCase().includes(f)) ||
      null
    );
  }

  function handle(name, input) {
    switch (name) {
      case 'get_context': {
        const acct = findAccount(input.focus);
        return acct ? { account: acct } : { account: null, note: 'no account matched' };
      }
      case 'query': {
        const scope = (input && input.scope) || 'all';
        if (scope === 'focus') {
          const focus = resolved.accounts
            .filter((a) => a.focusRank === 'high')
            .map((a) => ({
              name: a.name,
              icpFit: a.icpFit,
              hasFreshIntent: a.hasFreshIntent,
              reason: a.recentSignals.filter((s) => s.kind === 'intent')[0]?.detail || 'high ICP fit',
            }));
          return { accounts: focus };
        }
        // scope all: compact blocks
        return {
          accounts: resolved.accounts.map((a) => ({
            name: a.name,
            icpFit: a.icpFit,
            hasFreshIntent: a.hasFreshIntent,
            focusRank: a.focusRank,
          })),
        };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  return { tools, handle };
}

function toolsForArm(armName) {
  if (armName === 'reconstruct' || armName === 'A') return armATools();
  if (armName === 'graph' || armName === 'B') return armBTools();
  throw new Error(`unknown arm ${armName}`);
}

// ---------------------------------------------------------------------------
// The shared tool-use loop.
// ---------------------------------------------------------------------------

export async function runArm(armName, task, { model = DEFAULT_MODEL, apiKey } = {}) {
  if (!apiKey) throw new Error('runArm requires an apiKey (ANTHROPIC_API_KEY).');

  const client = new Anthropic({ apiKey });
  const { tools, handle } = toolsForArm(armName);

  const messages = [{ role: 'user', content: task.prompt }];

  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let answerText = '';

  const start = Date.now();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    inputTokens += resp.usage?.input_tokens ?? 0;
    outputTokens += resp.usage?.output_tokens ?? 0;

    // Collect any text this turn produced.
    const textParts = resp.content.filter((b) => b.type === 'text').map((b) => b.text);
    if (textParts.length) answerText = textParts.join('\n').trim();

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');

    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      // Model is done.
      break;
    }

    // Record the assistant turn, then answer each tool call.
    messages.push({ role: 'assistant', content: resp.content });

    const toolResults = [];
    for (const tu of toolUses) {
      toolCalls += 1;
      let result;
      try {
        result = handle(tu.name, tu.input || {});
      } catch (err) {
        result = { error: String(err && err.message ? err.message : err) };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  const latencyMs = Date.now() - start;

  return { answerText, inputTokens, outputTokens, latencyMs, toolCalls };
}

// Exposed for tests / inspection.
export { armATools, armBTools };
