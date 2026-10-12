// The API-plan top bar's context (GET-621), apart from the bar itself so PageHeader and the pages
// can read it without pulling the bar (and Get started with it) into their chunks.
import * as React from "react";

export type Parent = { label: string; href: string };

export type ConnectKind = "mcp" | "api";

/** A title the page lets you rename in place (a key's name, E1). */
export type TitleRename = {
  editing: boolean;
  onEdit: () => void;
  onSave: (value: string) => void;
  onCancel: () => void;
  validate?: (value: string) => string | null;
};

export type Slots = {
  title?: string;
  parent?: Parent | null;
  refreshing?: boolean;
  rename?: TitleRename;
};

export type Ctx = {
  setSlots: (s: Slots | null) => void;
  setRefresh: (fn: (() => void) | null) => void;
  filterSlot: HTMLElement | null;
  setFilterCount: React.Dispatch<React.SetStateAction<number>>;
  /** Open one of the Connect agent dialogs (A3/A4) from anywhere inside the shell. */
  openConnect: (kind: ConnectKind) => void;
  /** Whether the bar is drawn on this path (an API-plan page) — pages drop their title only then. */
  barShown: boolean;
};

export const ApiTopBarContext = React.createContext<Ctx | null>(null);

/** True inside the API-plan shell: pages drop their own title there, the bar carries it. */
export function useInApiShell(): boolean {
  return React.useContext(ApiTopBarContext)?.barShown ?? false;
}

/** Open the MCP or REST connect dialog. A no-op outside the API-plan shell. */
export function useOpenConnect(): ((kind: ConnectKind) => void) | null {
  return React.useContext(ApiTopBarContext)?.openConnect ?? null;
}

/**
 * A page's part of the bar: its title (when the route default isn't enough), its parent, and its
 * reload. Call it unconditionally; outside the API shell it does nothing. `enabled: false` for a
 * component that is sometimes embedded in another page (a dialog, a Settings tab), so it never
 * takes the bar from the page it sits in.
 */
export function useApiTopBar(opts: {
  title?: string | null; parent?: Parent | null; onRefresh?: () => void; refreshing?: boolean; enabled?: boolean;
  /** Makes the title editable in place; null/undefined keeps it plain. */
  rename?: TitleRename | null;
} = {}) {
  const ctxValue = React.useContext(ApiTopBarContext);
  const ctx = opts.enabled === false ? null : ctxValue;
  const refreshRef = React.useRef(opts.onRefresh);
  refreshRef.current = opts.onRefresh;
  const hasRefresh = !!opts.onRefresh;
  const { title, parent, refreshing } = opts;
  // The page's rename handlers change every render; the bar gets stable ones that call the latest.
  const renameRef = React.useRef(opts.rename);
  renameRef.current = opts.rename;
  const hasRename = !!opts.rename;
  const editing = !!opts.rename?.editing;
  const rename = React.useMemo<TitleRename | undefined>(() => (hasRename ? {
    editing,
    onEdit: () => renameRef.current?.onEdit(),
    onSave: (v) => renameRef.current?.onSave(v),
    onCancel: () => renameRef.current?.onCancel(),
    validate: (v) => renameRef.current?.validate?.(v) ?? null,
  } : undefined), [hasRename, editing]);
  const parentLabel = parent?.label;
  const parentHref = parent?.href;
  const noParent = parent === null;
  const setSlots = ctx?.setSlots;
  const setRefresh = ctx?.setRefresh;

  React.useEffect(() => {
    if (!setSlots) return;
    setSlots({
      title: title ?? undefined,
      parent: parentLabel && parentHref ? { label: parentLabel, href: parentHref } : noParent ? null : undefined,
      refreshing,
      rename,
    });
  }, [setSlots, title, parentLabel, parentHref, noParent, refreshing, rename]);

  React.useEffect(() => {
    if (!setRefresh || !hasRefresh) return;
    setRefresh(() => () => refreshRef.current?.());
    return () => setRefresh(null);
  }, [setRefresh, hasRefresh]);

  React.useEffect(() => () => setSlots?.(null), [setSlots]);
}
