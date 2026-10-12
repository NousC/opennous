// Keyboard first (standard 2, GET-601, interface refresh).
//
// One window listener for the whole app instead of a keydown handler per component. A binding is
// a single key ("c", "?", "j") or a two-key sequence ("g t": G, then T within a second). Keys are
// ignored while typing in a field, and when a modifier is held (⌘K and ⌘J keep their own
// handlers). When several mounted components bind the same key — two tables both wanting J — the
// most recently mounted one gets it, which is the one on top.
import { useEffect, useRef } from "react";

type Handler = (e: KeyboardEvent) => void;
const stacks = new Map<string, Handler[]>();
let pending: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable || !!t.closest("[role='dialog'] input, [role='combobox']");
}

function fire(combo: string, e: KeyboardEvent): boolean {
  const stack = stacks.get(combo);
  const handler = stack?.[stack.length - 1];
  if (!handler) return false;
  e.preventDefault();
  handler(e);
  return true;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || typing(e)) return;
  const key = e.key === "?" ? "?" : e.key.toLowerCase();
  if (pending) {
    const combo = `${pending} ${key}`;
    pending = null;
    if (pendingTimer) clearTimeout(pendingTimer);
    if (fire(combo, e)) return;
  }
  // A key that starts a sequence waits a second for its second key.
  if ([...stacks.keys()].some((c) => c.startsWith(`${key} `))) {
    pending = key;
    pendingTimer = setTimeout(() => { pending = null; }, 1000);
    if (!stacks.has(key)) return;
  }
  fire(key, e);
}

function install() {
  if (installed || typeof window === "undefined") return;
  window.addEventListener("keydown", onKeyDown);
  installed = true;
}

/** Bind `combo` ("c", "g t", "?") while the component is mounted and `enabled` is true. */
export function useHotkey(combo: string, handler: Handler, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    install();
    const h: Handler = (e) => ref.current(e);
    const stack = stacks.get(combo) ?? [];
    stack.push(h);
    stacks.set(combo, stack);
    return () => {
      const s = stacks.get(combo) ?? [];
      const i = s.lastIndexOf(h);
      if (i >= 0) s.splice(i, 1);
      if (!s.length) stacks.delete(combo);
    };
  }, [combo, enabled]);
}

/** Every shortcut, for the ? sheet and for tooltips. One list, so the two never disagree. */
export const SHORTCUTS: { group: string; items: { keys: string[]; label: string }[] }[] = [
  { group: "Anywhere", items: [
    { keys: ["⌘", "K"], label: "Search" },
    { keys: ["⌘", "J"], label: "Ask Nous" },
    { keys: ["C"], label: "New task" },
    { keys: ["?"], label: "Keyboard shortcuts" },
  ] },
  { group: "Go to", items: [
    { keys: ["G", "H"], label: "Home" },
    { keys: ["G", "A"], label: "Accounts" },
    { keys: ["G", "P"], label: "Pipeline" },
    { keys: ["G", "C"], label: "Customers" },
    { keys: ["G", "T"], label: "Tasks" },
    { keys: ["G", "R"], label: "Reporting" },
    { keys: ["G", "I"], label: "Insights" },
  ] },
  { group: "In a list", items: [
    { keys: ["J"], label: "Next row" },
    { keys: ["K"], label: "Previous row" },
    { keys: ["Enter"], label: "Open" },
    { keys: ["E"], label: "Mark done" },
  ] },
  { group: "On a record", items: [
    { keys: ["J"], label: "Next record" },
    { keys: ["K"], label: "Previous record" },
  ] },
];

/** The go-to sequences and where they lead. */
export const GO_TO: Record<string, string> = {
  "g h": "/", "g a": "/accounts", "g p": "/pipeline", "g c": "/customers", "g t": "/tasks", "g r": "/reporting", "g i": "/insights",
};
