// The builder's clarifying questions (GET-868), adapted from the in-app agent's ask card
// (cloud/pages/Home.tsx). One card, one or more questions: tabs when there are several, radio
// rows for a single choice, checkboxes for multi, and always an "Other" row with free text. The
// agent puts its recommended option first and marks it "(Recommended)"; the card lifts that
// marker out of the label into a quiet badge and pre-selects it, so the fast path is one click.
// Submit sends `{ answers: [{ id, selected, other? }] }` as the next turn.
import { useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BuilderAnswer, BuilderQuestion } from '@/lib/revboxes';

const RECOMMENDED = /\s*\(recommended\)\s*$/i;
const OTHER = '__other__';

export function AskCard({ questions, disabled, onSubmit }: { questions: BuilderQuestion[]; disabled?: boolean; onSubmit: (answers: BuilderAnswer[]) => void }) {
  // The recommended option starts picked on single-choice questions: answering "yes, that" is
  // the common case and should not cost a click per question.
  const initial = useMemo(() => Object.fromEntries(questions.map(q => {
    const rec = !q.multi ? q.options.find(o => RECOMMENDED.test(o.label)) : undefined;
    return [q.id, rec ? [rec.label] : []];
  })) as Record<string, string[]>, [questions]);
  const [picks, setPicks] = useState<Record<string, string[]>>(initial);
  const [other, setOther] = useState<Record<string, string>>({});
  const [tab, setTab] = useState(0);
  const otherInput = useRef<HTMLInputElement>(null);
  const q = questions[Math.min(tab, questions.length - 1)];
  if (!q) return null;
  const answered = (qq: BuilderQuestion) => (picks[qq.id] ?? []).some(p => p !== OTHER) || ((picks[qq.id] ?? []).includes(OTHER) && !!other[qq.id]?.trim());
  const allAnswered = questions.every(answered);
  const picked = picks[q.id] ?? [];

  function choose(label: string) {
    setPicks(prev => {
      const cur = prev[q.id] ?? [];
      const next = q.multi ? (cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label]) : [label];
      return { ...prev, [q.id]: next };
    });
    if (label === OTHER) requestAnimationFrame(() => otherInput.current?.focus());
  }
  function submit() {
    if (!allAnswered || disabled) return;
    onSubmit(questions.map(qq => {
      const sel = picks[qq.id] ?? [];
      const text = other[qq.id]?.trim();
      return { id: qq.id, selected: sel.filter(s => s !== OTHER), ...(sel.includes(OTHER) && text ? { other: text } : {}) };
    }));
  }
  // Single-choice questions move you along once picked; the last one waits for Submit.
  function next() { if (tab < questions.length - 1) setTab(t => t + 1); else submit(); }

  return <div
    className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-card animate-in fade-in slide-in-from-bottom-1 duration-200"
    onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); } }}
  >
    {questions.length > 1 && <div role="tablist" aria-label="Questions" className="flex items-center gap-1 overflow-x-auto border-b border-hairline px-2 pt-2">
      {questions.map((qq, i) => {
        const on = i === tab;
        return <button key={qq.id} role="tab" aria-selected={on} onClick={() => setTab(i)}
          onKeyDown={e => { if (e.key === 'ArrowRight') setTab(t => Math.min(questions.length - 1, t + 1)); if (e.key === 'ArrowLeft') setTab(t => Math.max(0, t - 1)); }}
          className={cn('flex shrink-0 items-center gap-1.5 rounded-t-lg px-3 py-1.5 text-[12px] font-medium transition-colors', on ? 'bg-muted text-foreground' : 'text-muted-foreground/70 hover:text-foreground')}>
          {answered(qq) && <Check className="h-3 w-3 text-emerald-600" strokeWidth={3} />}
          {qq.header || `Question ${i + 1}`}
        </button>;
      })}
    </div>}

    <fieldset className="p-2" disabled={disabled}>
      <legend className="px-2.5 pb-2 pt-2 text-[13.5px] font-medium leading-snug text-foreground">
        {q.question}{q.multi && <span className="ml-1.5 text-[11.5px] font-normal text-muted-foreground/70">pick any</span>}
      </legend>
      <div role={q.multi ? 'group' : 'radiogroup'} aria-label={q.header || q.question}>
        {q.options.map(o => {
          const recommended = RECOMMENDED.test(o.label);
          const on = picked.includes(o.label);
          return <label key={o.label} className={cn('relative flex cursor-pointer items-start gap-3 rounded-xl px-2.5 py-2.5 transition-colors duration-150', on ? 'bg-muted' : 'hover:bg-hover')}>
            <input type={q.multi ? 'checkbox' : 'radio'} name={`ask-${q.id}`} checked={on} onChange={() => choose(o.label)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); if (!q.multi) choose(o.label); next(); } }}
              className="peer sr-only" />
            <Mark multi={q.multi} on={on} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium leading-tight text-foreground">
                {o.label.replace(RECOMMENDED, '')}
                {recommended && <span className="rounded-md bg-emerald-600/10 px-1.5 py-px text-[10px] font-medium text-emerald-700 dark:text-emerald-400">Recommended</span>}
              </span>
              {o.description && <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">{o.description}</span>}
            </span>
          </label>;
        })}
        <label className={cn('relative flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 transition-colors duration-150', picked.includes(OTHER) ? 'bg-muted' : 'hover:bg-hover')}>
          <input type={q.multi ? 'checkbox' : 'radio'} name={`ask-${q.id}`} checked={picked.includes(OTHER)} onChange={() => choose(OTHER)} className="peer sr-only" />
          <Mark multi={q.multi} on={picked.includes(OTHER)} />
          <input ref={picked.includes(OTHER) ? otherInput : undefined} aria-label={`Other answer for ${q.header || q.question}`} value={other[q.id] ?? ''}
            placeholder="Other…" onFocus={() => { if (!picked.includes(OTHER)) choose(OTHER); }}
            onChange={e => setOther(prev => ({ ...prev, [q.id]: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); next(); } }}
            className="min-w-0 flex-1 bg-transparent py-0.5 text-[13px] outline-none placeholder:text-muted-foreground/60" />
        </label>
      </div>
    </fieldset>

    <div className="flex items-center justify-between gap-3 border-t border-hairline px-3 py-2.5">
      <span className="text-[11.5px] text-muted-foreground">{questions.length > 1 ? `${questions.filter(answered).length} of ${questions.length} answered` : 'Choose one, or write your own'}</span>
      <div className="flex items-center gap-2">
        {questions.length > 1 && tab < questions.length - 1 && <button type="button" onClick={() => setTab(t => t + 1)} className="rounded-lg px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground">Next</button>}
        <button type="button" onClick={submit} disabled={!allAnswered || disabled}
          className="rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-25">Submit</button>
      </div>
    </div>
  </div>;
}

function Mark({ multi, on }: { multi: boolean; on: boolean }) {
  // Drawn, not native: the native input stays for keyboard and screen readers (sr-only, peer),
  // and the focus ring follows it.
  return <span aria-hidden className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-foreground/20',
    multi ? 'rounded-[5px]' : 'rounded-full',
    on ? 'border-foreground bg-foreground text-background' : 'border-border text-transparent')}>
    {multi ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : <span className={cn('h-1.5 w-1.5 rounded-full', on ? 'bg-background' : 'bg-transparent')} />}
  </span>;
}
