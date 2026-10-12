import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// The market this workspace works — Spaces → Admin → Market focus (GET-319).
//
// It decides what the account and people lists, the pipeline tabs AND the revenue and win/loss
// reports COUNT. That is why it lives here rather than buried in personal settings: it is a
// workspace-wide decision about which business you are looking at, and a number on a report should
// never disagree with the list it came from.
//
// A default, never a restriction. Nothing is deleted, the country control on the Accounts list
// still overrides it per view, and accounts whose country the CRM never recorded are always kept —
// they are unrecorded, not foreign, and dropping a location because HubSpot has no city for it is
// the opposite of focusing a market.

type Country = { country: string; accounts: number };

export default function MarketFocus() {
  // Same shape the sidebar reads for this: the context is typed loosely and every caller casts.
  const { session, userData } = useAuth();
  const token = session?.access_token ?? null;
  const workspaceId = (userData as any)?.workspace?.id ?? "";
  const canEdit = ["founder", "owner", "admin"]
    .includes(String((userData as any)?.workspace_role ?? "").toLowerCase());

  const [focus, setFocus] = useState<string | null>(null);
  const [countries, setCountries] = useState<Country[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !workspaceId) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${apiUrl}/api/workspaces/${workspaceId}/settings`, {
          headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
        });
        if (!r.ok) throw new Error(`The server returned ${r.status}.`);
        const s = await r.json();
        if (!alive) return;
        setFocus(s.focus_country ?? null);
        setCountries(Array.isArray(s.countries) ? s.countries : []);
      } catch (e) {
        if (alive) setError((e as Error)?.message ?? "Could not load the market setting.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [token, workspaceId]);

  const choose = async (next: string | null) => {
    if (!canEdit || saving) return;
    const previous = focus;
    setFocus(next);
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${apiUrl}/api/workspaces/${workspaceId}/settings`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ focus_country: next ?? "" }),
      });
      if (!r.ok) throw new Error(`The server returned ${r.status}.`);
    } catch (e) {
      setFocus(previous);
      setError((e as Error)?.message ?? "That did not save.");
    } finally {
      setSaving(false);
    }
  };

  const total = countries.reduce((n, c) => n + c.accounts, 0);

  // A filter, not a page. It was a full-bleed screen with its own heading, three paragraphs and a
  // list of tappable rows — for a setting whose whole content is "which country". Inside General
  // it is the control it always was: one select, left-aligned, the same width as the fields above
  // it, with the consequence said once underneath.
  if (loading) return <p className="text-[12.5px] text-muted-foreground/70">Loading…</p>;

  if (countries.length === 0) {
    return (
      <p className="text-[12.5px] text-muted-foreground/70">
        No markets yet.
      </p>
    );
  }

  return (
    <div className="max-w-md">
      <select
        value={focus ?? ""}
        disabled={!canEdit || saving}
        onChange={(e) => choose(e.target.value || null)}
        className="h-9 w-full rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors focus:outline-none focus:ring-1 focus:ring-foreground/20 disabled:cursor-not-allowed disabled:opacity-70"
      >
        <option value="">Everywhere · {total.toLocaleString()} accounts</option>
        {countries.map((c) => (
          <option key={c.country} value={c.country}>
            {c.country} · {c.accounts.toLocaleString()} accounts
          </option>
        ))}
      </select>

      <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground/70">
        {focus
          ? `Accounts, People, the pipeline tabs and the reports all count ${focus}. Nothing is deleted — the rest are one click away on the Accounts list, and accounts with no recorded location are always included.`
          : "Every list and report counts every market. Pick one to focus them."}
      </p>

      {!canEdit && <p className="mt-2 text-[11.5px] text-muted-foreground/60">Only a workspace owner or admin can change this.</p>}
      {error && <p className="mt-2 text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
