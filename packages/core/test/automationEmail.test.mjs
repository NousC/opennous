// The email step's own Subject and Body (GET-551): variables filled from the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillTemplate, templateVarsForTest as templateVars, tidyBodyForTest as tidyBody, textToHtmlForTest as textToHtml } from '../dist/services/automationRun.mjs';

// Just enough of a Supabase client: each table answers with its fixture, whatever the filters.
function fakeDb(tables) {
  return {
    from(table) {
      const rows = tables[table] ?? [];
      const q = {
        select: () => q, eq: () => q, in: () => q, is: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve) => resolve({ data: rows, error: null }),
      };
      return q;
    },
  };
}

test('fillTemplate fills known variables and blanks unknown ones', () => {
  const out = fillTemplate('{{account.name}} won {{ deal.amount }} — {{nope.x}}!', { 'account.name': 'Corrigan Autos', 'deal.amount': '$12,000' });
  assert.equal(out, 'Corrigan Autos won $12,000 — !');
});

test('a closed-won run reads the account, the deal and the agent output', async () => {
  const automation = { steps: [{ id: 'smupvrfis1q', type: 'agent', config: {} }, { id: 'e1', type: 'email', config: {} }] };
  const doc = { title: 'Corrigan Autos — closed won', headline: 'Signed for 12 rooftops.', sections: [{ label: 'Deal', body: 'Three-year term [c1a2b].' }] };
  const supabase = fakeDb({
    entity_list_rows: [{ name: 'Corrigan Autos', domain: 'corrigan-autos.example', deal_health: 82 }],
    predictions: [{ predicted_value: { tier: 'A' } }],
    deal_outcomes: [{ deal_id: 'd1', value_usd: 9000, closed_at: '2026-09-28T00:00:00Z' }],
    claims: [
      { property: 'name', value: 'Corrigan — Enterprise' },
      { property: 'value', value: { value: 12000 } },
      { property: 'currency', value: 'USD' },
      { property: 'close_date', value: '2026-09-28' },
      { property: 'owner_name', value: 'Odile Brenner' },
    ],
  });
  const vars = await templateVars(automation, doc, {
    stage: 'closed_won', at: '2026-09-28T00:00:00Z',
    ctx: { supabase, workspaceId: 'w1', entityId: 'a1', dealId: 'd1' },
  });
  assert.equal(vars['account.name'], 'Corrigan Autos');
  assert.equal(vars['account.domain'], 'corrigan-autos.example');
  assert.equal(vars['account.tier'], 'A');
  assert.equal(vars['account.owner'], 'Odile Brenner');
  assert.equal(vars['deal.name'], 'Corrigan — Enterprise');
  assert.equal(vars['deal.amount'], '$12,000');
  assert.equal(vars['deal.close_date'], 'September 28, 2026');
  assert.equal(vars['deal.stage'], 'Closed won');
  assert.equal(vars['deal.owner'], 'Odile Brenner');
  assert.equal(vars['steps.smupvrfis1q.output'], 'Signed for 12 rooftops.\n\nDeal\nThree-year term.');
  assert.equal(
    fillTemplate('{{account.name}} closed won on {{deal.close_date}} ({{deal.amount}}, owner {{deal.owner}}).', vars),
    'Corrigan Autos closed won on September 28, 2026 ($12,000, owner Odile Brenner).',
  );
});

test('without a database it still has the name, stage and date from the run', async () => {
  const vars = await templateVars({ steps: [] }, { title: 'Apex Lane Motors — closed won' }, { stage: 'closed_won', at: '2026-09-24T00:00:00Z' });
  assert.equal(vars['account.name'], 'Apex Lane Motors');
  assert.equal(vars['deal.stage'], 'Closed won');
  assert.equal(vars['deal.close_date'], 'September 24, 2026');
});

test('a pasted body keeps its paragraphs and loses its indentation', () => {
  const pasted = '  Hi Odile,\n\n  Corrigan Autos closed won.   \n  Deal: Enterprise.\n\n\n\n  The PDF is attached.\n';
  const body = tidyBody(pasted);
  assert.equal(body, 'Hi Odile,\n\nCorrigan Autos closed won.\nDeal: Enterprise.\n\nThe PDF is attached.');
  assert.equal(textToHtml(body), '<p>Hi Odile,</p><p>Corrigan Autos closed won.<br>Deal: Enterprise.</p><p>The PDF is attached.</p>');
});

// Preview (GET-566): the latest closes are the samples, one per account; without a written
// document the AI output says it is not there yet rather than previewing as blank.
import { previewAutomationVars } from '../dist/services/automationRun.mjs';

function previewDb(tables) {
  return {
    from(table) {
      const q = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve) => resolve({ data: tables[table] ?? [], error: null });
          if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null });
          return () => q;
        },
      });
      return q;
    },
  };
}

test('preview samples the latest closes, one per account, and marks a missing AI output', async () => {
  const db = previewDb({
    deal_outcomes: [
      { entity_id: 'a1', deal_id: 'd1', closed_at: '2026-09-30T00:00:00Z' },
      { entity_id: 'a1', deal_id: 'd0', closed_at: '2026-09-29T00:00:00Z' },
      { entity_id: 'a2', deal_id: 'd2', closed_at: '2026-09-28T00:00:00Z' },
    ],
    entity_list_rows: [{ entity_id: 'a1', name: 'Northcape Motors' }, { entity_id: 'a2', name: 'Fallowmere Mitsubishi' }],
    documents: [],
  });
  const steps = [{ id: 'agent', type: 'agent', config: {} }, { id: 'email', type: 'email', config: {} }];
  const out = await previewAutomationVars(db, 'w1', { when: 'deal_closed_won', steps });
  assert.deepEqual(out.samples.map(s => s.entity_id), ['a1', 'a2']);
  assert.equal(out.sample.deal_id, 'd1');
  assert.equal(out.vars['deal.stage'], 'Closed won');
  assert.match(out.vars['steps.agent.output'], /writes this when the automation runs/);
});

// The simple editor's preview (GET-664): the email a real run would send, built by the send's
// own code — notice + PDF by default, the AI's words in the body when that is what it says.
import { automationEmailPreview } from '../dist/services/automationRun.mjs';

test('email preview: the default notice with the PDF, to the step\'s people', async () => {
  const db = previewDb({
    deal_outcomes: [{ entity_id: 'a1', deal_id: 'd1', closed_at: '2026-09-28T00:00:00Z' }],
    entity_list_rows: [{ entity_id: 'a1', name: 'Corrigan Autos' }],
    documents: [],
  });
  const steps = [{ id: 'agent', type: 'agent', config: {} }, { id: 'email', type: 'email', config: { to: 'odile@harborline.example', cc: 'a@b.example' } }];
  const out = await automationEmailPreview(db, 'w1', { when: 'deal_closed_won', steps });
  assert.equal(out.email.to, 'odile@harborline.example');
  assert.deepEqual(out.email.cc, ['a@b.example']);
  assert.match(out.email.subject, /^Corrigan Autos · September 28, 2026 · Closed Won$/);
  assert.match(out.email.text, /^Corrigan Autos closed won on September 28, 2026\./);
  assert.equal(out.email.attach, true);
  assert.equal(out.email.filename, 'Corrigan Autos Account Brief.pdf');
});

test('email preview: the AI\'s words in the body, nothing attached', async () => {
  const db = previewDb({
    deal_outcomes: [{ entity_id: 'a1', deal_id: 'd1', closed_at: '2026-09-28T00:00:00Z' }],
    entity_list_rows: [{ entity_id: 'a1', name: 'Corrigan Autos' }],
    documents: [{ id: 'doc1', title: 'Corrigan Autos — closed won', headline: 'Signed for 12 rooftops.', sections: [{ label: 'Next', body: 'Kickoff Monday.' }], created_at: '2026-09-28T10:00:00Z' }],
  });
  const steps = [{ id: 'agent', type: 'agent', config: {} }, { id: 'email', type: 'email', config: { to: 'k@a.example', body: '{{steps.agent.output}}', attach: 'none' } }];
  const out = await automationEmailPreview(db, 'w1', { when: 'deal_closed_won', steps });
  assert.equal(out.email.attach, false);
  assert.equal(out.email.text, 'Signed for 12 rooftops.\n\nNext\nKickoff Monday.');
  assert.equal(out.written, true);
});
