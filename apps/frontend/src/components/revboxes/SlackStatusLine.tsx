// Slack trouble in one small line (GET-901), as the server words it: "Slack disconnected · Reconnect",
// "Invite @Nous to #channel · Copy /invite @Nous", "Channel archived". Used on a job's card, the
// Delivery rail and a failed run in Results. Clicks inside never open the row it sits in.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SlackStatus } from '@/lib/revboxes';

/** Connection trouble reads red; a channel to fix reads amber. */
export const slackStatusTone = (s: SlackStatus) => (s.kind === 'disconnected' || s.kind === 'broken' ? 'text-risk' : 'text-amber-700 dark:text-amber-400');

export function SlackStatusLine({ status, className }: { status: SlackStatus | null | undefined; className?: string }) {
  const [copied, setCopied] = useState(false);
  if (!status) return null;
  const copy = async () => {
    if (!status.copy) return;
    try { await navigator.clipboard.writeText(status.copy); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the command is shown; copying is a convenience */ }
  };
  return <span role="status" className={cn('inline-flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11.5px] leading-5', className)}
    onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <span className={cn('truncate font-medium', slackStatusTone(status))}>{status.text}</span>
    {status.fix && <>
      <span aria-hidden className="text-muted-foreground/50">·</span>
      <Link to={status.fix.href} className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline">{status.fix.label}<ArrowUpRight className="h-3 w-3" /></Link>
    </>}
    {status.copy && <>
      <span aria-hidden className="text-muted-foreground/50">·</span>
      <button type="button" onClick={() => void copy()} title={`Copy ${status.copy}, then send it in the channel`}
        className="inline-flex items-center gap-1 rounded font-mono text-[11px] text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60">
        {status.copy}{copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
      </button>
    </>}
  </span>;
}
