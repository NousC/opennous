import { useState } from "react";
import { Sparkles, Copy, Check } from "lucide-react";

// AgentSetupHint — a small, repeated cue that a setup task is done by the agent,
// not by clicking through a form here. Shows a one-line framing and a
// copy-paste prompt the user can hand to their agent in Claude. The manual path
// stays as a quiet fallback wherever this is used (agent-first, human fallback).
export function AgentSetupHint({ prompt, line }: { prompt: string; line?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(prompt)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="rounded-xl border border-border bg-muted/30 px-4 py-3.5 text-left">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="h-3.5 w-3.5 text-foreground/60 flex-shrink-0" strokeWidth={1.75} />
        <span className="text-[12.5px] font-semibold text-foreground/80">
          {line || "Your agent sets this up"}
        </span>
      </div>
      <button
        onClick={copy}
        title="Copy this prompt"
        className="group flex w-full items-center justify-between gap-3 rounded-lg border border-border/70 bg-background px-3 py-2 text-left hover:border-border transition-colors"
      >
        <code className="text-[12.5px] font-mono text-foreground/80 truncate">{prompt}</code>
        {copied ? (
          <Check className="h-3.5 w-3.5 text-foreground/70 flex-shrink-0" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground/60 group-hover:text-foreground/70 flex-shrink-0" />
        )}
      </button>
    </div>
  );
}
