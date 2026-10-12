// Connect with the REST API (GET-627): the base URL, a key, one real lookup in three languages,
// the four calls people reach for first, and the way to webhooks.

import * as React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check, Code2, Webhook } from "lucide-react";
import { Dialog, DialogContent, DialogDescription } from "@/components/ui/dialog";
import { DOCS_URL, apiBaseUrl } from "@/config/agentEndpoints";
import { COMMON_CALLS, restLookup, type RestLang } from "@/lib/connectSnippets";
import { cn } from "@/lib/utils";
import { CodeSnippet, ConnectFoot, ConnectHead, KeyPicker, fieldLabel, useChosenKey, useWorkspaceKeys } from "./shared";

const LANGS: [RestLang, string][] = [["curl", "curl"], ["js", "JavaScript"], ["py", "Python"]];

export function ConnectApiDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [lang, setLang] = React.useState<RestLang>("curl");
  const { data: keys } = useWorkspaceKeys(false);
  const { key, setKey } = useChosenKey(keys);
  const base = apiBaseUrl();
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideCloseButton className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[560px] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto rounded-[14px] p-0">
        <ConnectHead icon={Code2} title="Connect with the REST API" />
        <DialogDescription className="sr-only">Call the Nous REST API with an API key.</DialogDescription>
        <div className="flex flex-col gap-4 px-5 pb-5 pt-[18px] text-[13px]">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <span className={fieldLabel}>Base URL</span>
              <CopyField value={`${base}/v2`} />
            </div>
            <div className="min-w-0">
              <span className={fieldLabel}>Your key</span>
              <KeyPicker compact keys={keys ?? []} value={key?.id ?? null} onChange={setKey} onNew={close} />
            </div>
          </div>

          <div>
            <div role="tablist" aria-label="Language" className="mb-2 inline-flex rounded-lg bg-muted p-0.5 text-[12.5px]">
              {LANGS.map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={lang === id} onClick={() => setLang(id)}
                  className={cn("rounded-md px-2.5 py-1 transition-colors duration-fast",
                    lang === id ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {label}
                </button>
              ))}
            </div>
            <CodeSnippet code={restLookup(lang, base)} />
          </div>

          <div>
            <span className={fieldLabel}>Common calls</span>
            <ul>
              {COMMON_CALLS.map((c) => (
                <li key={c.method + c.path} className="flex items-center gap-2.5 border-b border-hairline py-2 last:border-0">
                  <span className={cn("w-10 shrink-0 font-mono text-[10.5px] font-semibold",
                    c.method === "GET" ? "text-positive" : "text-brand")}>{c.method}</span>
                  <span className="w-[118px] shrink-0 truncate font-mono sm:w-[150px] text-[12px] text-foreground">{c.path}</span>
                  <span className="min-w-0 truncate text-[12px] text-muted-foreground">{c.what}</span>
                </li>
              ))}
            </ul>
          </div>

          <Link to="/webhooks" onClick={close}
            className="flex items-center gap-2.5 rounded-[10px] border border-hairline bg-muted/40 px-3 py-2.5 transition-colors duration-fast hover:bg-hover">
            <Webhook className="h-4 w-4 shrink-0 text-ink-2" strokeWidth={1.7} />
            <span className="flex-1 text-foreground">Get events pushed to you</span>
            <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">Webhooks<ArrowRight className="h-3 w-3" strokeWidth={1.8} /></span>
          </Link>
        </div>
        <ConnectFoot docsHref={`${DOCS_URL}/public-api/introduction`} docsLabel="API reference" />
      </DialogContent>
    </Dialog>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg border border-border bg-card pl-2.5 pr-1">
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">{value}</span>
      <button type="button"
        onClick={() => navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {})}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-foreground">
        {copied ? <><Check className="h-3 w-3" strokeWidth={2.2} />Copied</> : "Copy"}
      </button>
    </div>
  );
}
