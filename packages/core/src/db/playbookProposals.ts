/**
 * Playbooks that keep themselves current (GET-470).
 *
 * A playbook goes stale the moment the team decides something new in a meeting. So a routine reads
 * what the brain now holds — what the team believes (Internal Insights syntheses), the decisions
 * made since the playbook last changed, the competitor pages — and drafts the playbook's next
 * version as a PROPOSAL. Nothing is overwritten: the playbook page shows "proposed update waiting",
 * a person reviews the diff and applies it, or dismisses it.
 *
 * A proposal is a hidden brain page (`_proposals/Playbooks/<Name>`) with three sections: the
 * proposed playbook, what changed and why (each change linked to its evidence), and the open
 * questions. A newer draft replaces the older one as its next version.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeDocument, sectionText, type DocumentRow, type DocumentSection } from './documents.js';
import type { Brain } from './brains.js';

export const PROPOSAL_PREFIX = '_proposals/';
export const proposalPath = (playbook: string) => `${PROPOSAL_PREFIX}Playbooks/${playbook}`;

/** Which "what we believe" topics bear on each playbook. */
export const PLAYBOOK_TOPICS: Record<string, string[]> = {
  Positioning: ['Positioning', 'Competitors'],
  ICP: ['Customers', 'Market', 'Sales & Pipeline'],
  Market: ['Market', 'Competitors'],
  Distribution: ['Distribution', 'Sales & Pipeline'],
  Pricing: ['Pricing'],
};

export interface PlaybookProposal { proposed: string; why: string; open: string }

/** The model's markdown → the three parts, or null when it did not write them. */
export function parseProposal(text: string): PlaybookProposal | null {
  const t = String(text ?? '');
  const part = (heading: string, next: string[]) => {
    const i = t.search(new RegExp(`^##\\s+${heading}`, 'mi'));
    if (i < 0) return '';
    const after = t.slice(i).replace(/^##[^\n]*\n/, '');
    const ends = next.map(h => after.search(new RegExp(`^##\\s+${h}`, 'mi'))).filter(n => n >= 0);
    return (ends.length ? after.slice(0, Math.min(...ends)) : after).replace(/\n---[\s\S]*$/, '').trim();
  };
  const proposed = part('Proposed playbook', ['What changed', 'Open questions']);
  const why = part('What changed', ['Open questions']);
  const open = part('Open questions', []);
  return proposed && why ? { proposed, why, open } : null;
}

export function buildPlaybookProposalPrompt(input: {
  company: string; name: string; current: string; beliefs: string; decisions: string; competitors: string;
}): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…` : s);
  return [
    `You are the head of GTM at ${input.company}, updating the ${input.name.toUpperCase()} playbook from what the company brain now knows.`,
    'Business executive register: declarative, specific, quantified, conclusion first. No narrative, no hype, no evaluative adjectives.',
    '',
    `CURRENT ${input.name.toUpperCase()} PLAYBOOK${input.current.trim() ? '' : ' (not written yet — draft it from the evidence)'}:`,
    clip(input.current, 12000) || '(empty)',
    '',
    'EVIDENCE — what the team currently believes, per topic, with the meetings behind it:', clip(input.beliefs, 14000) || '(none)',
    '', 'EVIDENCE — decisions made since the playbook last changed (newest first):', clip(input.decisions, 12000) || '(none)',
    '', 'EVIDENCE — competitors:', clip(input.competitors, 10000) || '(none)',
    '',
    'OUTPUT (markdown only, no preamble), exactly these three sections:',
    '## Proposed playbook',
    `(the full ${input.name} playbook as it should now read: keep what is still true, change what the evidence changed, add what is missing; the same structure as the current one where it has one)`,
    '## What changed and why',
    '(one bullet per change: the change, then its evidence as a link — [[Decisions]], [[Internal Meetings/Internal Insights|Internal Insights]], a meeting link as given in the evidence, or [[Playbooks/Competitors/<Name>|<Name>]]; say when a change rests on one meeting)',
    '## Open questions',
    '(what the evidence does not settle and a person must decide; "None." if nothing)',
    '',
    'Rules: never invent a figure, customer or price that is not in the current playbook or the evidence. A decision about one client\'s setup, deadline or data is NOT a playbook change. If nothing in the evidence changes the playbook, return the current text under Proposed playbook and "No change." under What changed and why.',
  ].join('\n');
}

/** Save a proposal as its playbook's next proposal. */
export async function saveProposal(
  supabase: SupabaseClient, workspaceId: string, brain: Brain, playbook: string, p: PlaybookProposal,
): Promise<DocumentRow> {
  return writeDocument(supabase, workspaceId, {
    kind: 'brain_page',
    title: `Proposed update — ${playbook}`,
    sections: [
      { label: 'Proposed playbook', body: p.proposed },
      { label: 'What changed and why', body: p.why },
      { label: 'Open questions', body: p.open || 'None.' },
    ],
    writtenBy: 'routine',
    skill: 'playbook-proposal',
    brainId: brain.id,
    brainPath: proposalPath(playbook),
  });
}

/** A stored proposal's parts. */
export function proposalParts(doc: DocumentRow): PlaybookProposal {
  const secs = (doc.sections ?? []) as DocumentSection[];
  const body = (label: string) => sectionText(secs.find(s => s.label === label) ?? { label, body: '' });
  return { proposed: body('Proposed playbook'), why: body('What changed and why'), open: body('Open questions') };
}

/** Close a proposal: applied or dismissed, it stops showing. The row is kept. */
export async function closeProposal(supabase: SupabaseClient, workspaceId: string, documentId: string): Promise<void> {
  const { error } = await supabase.from('documents').update({ status: 'superseded', updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('id', documentId).eq('kind', 'brain_page');
  if (error) throw error;
}
