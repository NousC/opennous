// Connect over MCP (GET-626): pick a client, paste two steps, watch the key's first call land.
//
// The copy follows how the server really authenticates — a pk_ key as a Bearer header on the
// hosted /mcp, or NOUS_API_KEY for the stdio package — see lib/connectSnippets.ts.

import * as React from "react";
import { ChevronDown, SquareTerminal } from "lucide-react";
import { Dialog, DialogContent, DialogDescription } from "@/components/ui/dialog";
import { DOCS_URL, MCP_URL } from "@/config/agentEndpoints";
import { MCP_TOOLS } from "@/config/mcpTools";
import { cloud } from "@/lib/cloud";

// What the server lists: the public tools, plus Cloud's after `score` (GET-839).
const at = MCP_TOOLS.indexOf("score") + 1;
const TOOLS = [...MCP_TOOLS.slice(0, at), ...(cloud.mcpTools ?? []), ...MCP_TOOLS.slice(at)];
import { keyStatus, mcpSteps, type McpClient } from "@/lib/connectSnippets";
import { cn } from "@/lib/utils";
import { CodeSnippet, ConnectFoot, ConnectHead, KeyPicker, fieldLabel, useChosenKey, useWorkspaceKeys, ClientLogo } from "./shared";

const CLIENTS: { id: McpClient; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex",  label: "Codex" },
  { id: "other",  label: "Other" },
];

export function ConnectMcpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [client, setClient] = React.useState<McpClient>("claude");
  const [toolsOpen, setToolsOpen] = React.useState(false);
  // Poll while open: the status line flips the moment the key makes its first call.
  const { data: keys } = useWorkspaceKeys(open ? 5_000 : false);
  const { key, setKey } = useChosenKey(keys);
  const status = keyStatus(key?.last_used_at);
  const steps = mcpSteps(client, MCP_URL);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideCloseButton className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[560px] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto rounded-[14px] p-0">
        <ConnectHead icon={SquareTerminal} title="Connect over MCP" />
        <DialogDescription className="sr-only">Add the Nous MCP server to your coding agent with an API key.</DialogDescription>
        <div className="flex flex-col gap-[18px] px-5 pb-5 pt-[18px] text-[13px]">
          <div>
            <span className={fieldLabel}>Client</span>
            <div role="radiogroup" aria-label="Client" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {CLIENTS.map((c) => {
                const on = c.id === client;
                return (
                  <button key={c.id} type="button" role="radio" aria-checked={on} onClick={() => setClient(c.id)}
                    className={cn(
                      "inline-flex h-[34px] items-center gap-[7px] rounded-[9px] border bg-card px-2.5 text-[12.5px] font-medium transition-colors duration-fast",
                      on ? "border-foreground/25 bg-hover text-foreground" : "border-border text-ink-2 hover:border-foreground/20 hover:text-foreground",
                    )}>
                    <ClientLogo id={c.id} size={15} />
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <span className={fieldLabel}>Your key</span>
            <KeyPicker keys={keys ?? []} value={key?.id ?? null} onChange={setKey} onNew={() => onOpenChange(false)} />
          </div>

          <ol className="flex flex-col gap-3.5">
            {steps.map((s, i) => (
              <li key={`${client}-${i}`} className="flex gap-2.5">
                <span className="mt-px inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-muted text-[10.5px] font-semibold text-ink-2">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <StepLabel label={s.label} mono={s.mono} />
                  {s.code && <CodeSnippet code={s.code} className="mt-2" />}
                </div>
              </li>
            ))}
          </ol>

          <div className="border-t border-hairline pt-3.5">
            <div className="flex items-center gap-2">
              <span aria-hidden className={cn(
                "h-[7px] w-[7px] shrink-0 rounded-full",
                status.connected ? "bg-positive shadow-[0_0_0_3px_hsl(var(--positive)/0.18)]" : "bg-warning-dot shadow-[0_0_0_3px_hsl(var(--warning-dot)/0.18)]",
              )} />
              <span className="flex-1" aria-live="polite">{key ? status.text : "Choose a key to watch for its first call"}</span>
              <button type="button" aria-expanded={toolsOpen} onClick={() => setToolsOpen((o) => !o)}
                className="inline-flex h-6 items-center gap-1 text-[12.5px] font-medium text-ink-2 transition-colors hover:text-foreground">
                {TOOLS.length} tools
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-fast", toolsOpen && "rotate-180")} strokeWidth={1.8} />
              </button>
            </div>
            {toolsOpen && (
              <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {TOOLS.map((t) => (
                  <span key={t} className="truncate rounded-md bg-muted/60 px-2 py-[5px] font-mono text-[11.5px] text-foreground/80">{t}</span>
                ))}
              </div>
            )}
          </div>
        </div>
        <ConnectFoot docsHref={`${DOCS_URL}/mcp/introduction`} docsLabel="Docs" />
      </DialogContent>
    </Dialog>
  );
}

/** A step's sentence, with the one command or path in it set in mono. */
function StepLabel({ label, mono }: { label: string; mono?: string }) {
  if (!mono || !label.includes(mono)) return <span>{label}</span>;
  const [before, after] = label.split(mono);
  return (
    <span>
      {before}
      <span className="rounded bg-muted px-[5px] py-px font-mono text-[12px]">{mono}</span>
      {after}
    </span>
  );
}
