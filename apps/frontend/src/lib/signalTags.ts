// A signal's tag (GET-894): the tinted pill for an account signal's kind, and the line beside it.
// The server decides the tone of every kind once (packages/core/src/services/signalTone.mjs; the API
// sends `label`, `tone` and `text` with the latest signal). This file only paints a tone, so it holds
// the palette and nothing about meanings. Pure, so tests/signalTags.test.ts can pin it.

export type SignalTone = 'red' | 'green' | 'blue' | 'amber' | 'orange' | 'purple' | 'slate' | 'teal' | 'pink' | 'indigo';

/** Tinted, not loud: a 10% wash and a readable ink, lighter ink in dark mode. Literal strings so Tailwind keeps them. */
export const SIGNAL_TONE_CLASS: Record<SignalTone, string> = {
  red: 'bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  green: 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  blue: 'bg-blue-500/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  amber: 'bg-amber-500/10 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  orange: 'bg-orange-500/10 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  purple: 'bg-violet-500/10 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  slate: 'bg-slate-500/10 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300',
  teal: 'bg-teal-500/10 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  pink: 'bg-pink-500/10 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300',
  indigo: 'bg-indigo-500/10 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
};

export type LatestSignal = { kind: string; title?: string | null; at?: string | null; label?: string | null; tone?: string | null; text?: string | null };

const sentence = (kind: string) => {
  const w = kind.replace(/^custom_/, '').replace(/[_.]+/g, ' ').trim() || 'signal';
  return w[0].toUpperCase() + w.slice(1);
};

/** What the cell shows: the pill's label and class, the line, and the full text for the tooltip. */
export function signalTag(s: LatestSignal) {
  const label = s.label?.trim() || sentence(String(s.kind ?? ''));
  const tone = (s.tone && s.tone in SIGNAL_TONE_CLASS ? s.tone : 'slate') as SignalTone;
  const text = s.text?.trim() || (s.label ? '' : s.title?.trim() ?? '') || null;
  return { label, tone, className: SIGNAL_TONE_CLASS[tone], text, tooltip: text ? `${label} · ${text}` : label };
}
