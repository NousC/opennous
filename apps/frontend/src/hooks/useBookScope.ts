// "My book" vs "Whole team": one rule for every page that has the toggle (Home, Pipeline,
// Customers), so switching it on one page doesn't surprise you on the next.
//
// The default follows the seat: a manager (owner/admin/founder) runs the team and lands on
// the whole team; a rep works the book and lands on their own. On Customers "mine" means the
// accounts you are the CS OWNER of, which for a founder is usually nobody (the CS owner differs
// from the AE on almost every account), so defaulting a founder to "mine" would open on an
// empty page. Once you pick, the choice sticks for this workspace in this browser.
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { roleOf } from "@/lib/roles";

export type BookScope = "mine" | "team";

const keyFor = (ws: string) => `nous.bookScope:${ws}`;

export function useBookScope(): [BookScope, (s: BookScope) => void] {
  const { userData } = useAuth();
  const ws = (userData as { workspace?: { id?: string } })?.workspace?.id ?? "";
  const fallback: BookScope = roleOf(userData) === "rep" ? "mine" : "team";

  const read = useCallback((): BookScope => {
    try {
      const v = ws ? localStorage.getItem(keyFor(ws)) : null;
      return v === "mine" || v === "team" ? v : fallback;
    } catch { return fallback; }
  }, [ws, fallback]);

  const [scope, setScopeState] = useState<BookScope>(read);
  // The role and workspace arrive after first paint; re-read once they do.
  useEffect(() => { setScopeState(read()); }, [read]);

  // Other tabs/pages that set it in this session follow along.
  useEffect(() => {
    const onChange = (e: Event) => {
      const d = (e as CustomEvent).detail as { ws?: string; scope?: BookScope } | undefined;
      if (d?.ws === ws && d.scope) setScopeState(d.scope);
    };
    window.addEventListener("nous-book-scope", onChange);
    return () => window.removeEventListener("nous-book-scope", onChange);
  }, [ws]);

  const setScope = useCallback((s: BookScope) => {
    setScopeState(s);
    try { if (ws) localStorage.setItem(keyFor(ws), s); } catch { /* private window */ }
    window.dispatchEvent(new CustomEvent("nous-book-scope", { detail: { ws, scope: s } }));
  }, [ws]);

  return [scope, setScope];
}
