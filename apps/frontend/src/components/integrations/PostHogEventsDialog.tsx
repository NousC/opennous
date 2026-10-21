// Which PostHog events we receive (GET-751), changed without reconnecting: the signup event that
// adds a person and their account, and the key events that mean real use. The events the project
// actually sent in the last 30 days are offered to pick from, most frequent first, so nobody has
// to know or type an event name; one that has not been sent yet can still be added by name.
// Saving updates the destination's filter in the customer's PostHog project and the settings.
import * as React from "react";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const MAX_KEY_EVENTS = 10;

type Available = { name: string; count: number; people: number };
type Events = { signup_event: string; key_events: string[]; destination: boolean; available?: Available[] };

const fmt = (n: number) => n.toLocaleString("en-US");

export function PostHogEventsDialog({ connectionId, token, open, onOpenChange }: {
  connectionId: string; token: string | null; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const [loaded, setLoaded] = React.useState<Events | null>(null);
  const [signup, setSignup] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);
  const [extra, setExtra] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    if (!open || !token) return;
    setError(null); setSaved(false);
    fetch(`${apiUrl}/api/workflow-providers/connections/${connectionId}/posthog-events`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.message ?? body.error ?? "Could not read the settings.");
        setLoaded(body); setSignup(body.signup_event ?? "signed_up"); setPicked(body.key_events ?? []);
      })
      .catch((e) => setError(e.message));
  }, [open, token, connectionId]);

  // What to offer: the project's own events, then anything already chosen that it has not sent lately.
  const available = loaded?.available ?? [];
  const options: Available[] = [
    ...available,
    ...picked.filter((p) => !available.some((a) => a.name === p)).map((name) => ({ name, count: 0, people: 0 })),
  ];
  const signupOptions = [...new Set([signup, ...available.map((a) => a.name)].filter(Boolean))];
  const keyOptions = options.filter((o) => o.name !== signup);
  const full = picked.length >= MAX_KEY_EVENTS;

  const toggle = (name: string, on: boolean) => {
    setSaved(false);
    setPicked((cur) => on ? (cur.includes(name) || cur.length >= MAX_KEY_EVENTS ? cur : [...cur, name]) : cur.filter((n) => n !== name));
  };
  const addExtra = () => {
    const name = extra.trim();
    if (name && !picked.includes(name) && !full) setPicked((cur) => [...cur, name]);
    setExtra(""); setSaved(false);
  };

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const r = await fetch(`${apiUrl}/api/workflow-providers/connections/${connectionId}/posthog-events`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ signup_event: signup, key_events: picked.filter((p) => p !== signup).join(", ") }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message ?? body.error ?? "Could not save.");
      setLoaded((cur) => ({ ...(cur ?? body), ...body, available: cur?.available ?? [] }));
      setSignup(body.signup_event); setPicked(body.key_events ?? []); setSaved(true);
    } catch (e: any) {
      setError(e?.message ?? "Could not save.");
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px]">
        <DialogTitle className="text-[15px]">PostHog events</DialogTitle>
        <DialogDescription className="text-[12.5px]">
          A signup adds the person and their account. Key events are the moments that mean real use: we count them per account every day, flag the first time an account does each, and automations can run on them.
        </DialogDescription>

        <div className="mt-2 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[12.5px]">Signup event</Label>
            <Select value={signup} onValueChange={(v) => { setSignup(v); setPicked((cur) => cur.filter((n) => n !== v)); setSaved(false); }} disabled={!loaded}>
              <SelectTrigger className="h-9 text-[13px]"><SelectValue placeholder="signed_up" /></SelectTrigger>
              <SelectContent>
                {signupOptions.map((n) => <SelectItem key={n} value={n} className="text-[13px]">{n}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label className="text-[12.5px]">Key events</Label>
              <span className="text-[12px] tabular-nums text-muted-foreground">{picked.filter((p) => p !== signup).length} of {MAX_KEY_EVENTS}</span>
            </div>
            {!loaded && !error && <p className="text-[12.5px] text-muted-foreground">Reading your PostHog events…</p>}
            {loaded && keyOptions.length === 0 && (
              <p className="text-[12.5px] text-muted-foreground">Your project has sent no events of its own in the last 30 days. Add one by name below.</p>
            )}
            {keyOptions.length > 0 && (
              <div className="max-h-[240px] space-y-0.5 overflow-y-auto rounded-lg border border-hairline p-1">
                {keyOptions.map((o) => {
                  const on = picked.includes(o.name);
                  return (
                    <label key={o.name} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover">
                      <Checkbox checked={on} disabled={!on && full} onCheckedChange={(v) => toggle(o.name, v === true)} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{o.name}</span>
                      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                        {o.count ? `${fmt(o.count)} · ${o.people} ${o.people === 1 ? "person" : "people"}` : "not sent lately"}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Input value={extra} onChange={(e) => setExtra(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExtra(); } }}
                placeholder="Another event by name" className="h-8 text-[12.5px]" disabled={full || !loaded} />
              <Button variant="outline" size="sm" onClick={addExtra} disabled={!extra.trim() || full || !loaded}>Add</Button>
            </div>
          </div>

          {loaded && !loaded.destination && (
            <p className="text-[12px] text-muted-foreground">
              No live destination yet (the key cannot create one), so these only change what the daily usage read counts.
            </p>
          )}
          {error && <p className="text-[12.5px] text-destructive">{error}</p>}
          {saved && !error && (
            <p className="flex items-center gap-1.5 text-[12.5px] text-positive">
              <Check className="size-3.5" strokeWidth={2} /> Saved. PostHog now sends these to us, and the next daily read counts them.
            </p>
          )}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
          <Button size="sm" onClick={save} disabled={busy || !loaded}>{busy ? "Saving…" : saved ? "Saved" : "Save"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
