// Optimistic actions with Undo (standard 1, GET-595).
//
// Mark done, approve, send, snooze, dismiss: the screen changes the instant you act, the
// toast says what happened and offers Undo, and if the server says no, the screen goes back
// and says nothing was changed. Never a spinner on something the user just did.
//
// Every page's actions go through this one hook instead of hand-rolled local state and
// rollback (Tasks, the sidebar and Home each had their own before the refresh).
//
//   const markDone = useOptimisticMutation({
//     mutationFn: (t: Task) => api.patch(`/tasks/${t.id}`, { done: true }),
//     updates: [optimistic<Task[], Task>(["tasks"], (old, t) => old?.filter((x) => x.id !== t.id))],
//     toast: (t) => ({ title: "Marked done", description: t.title }),
//     undo: (t) => api.patch(`/tasks/${t.id}`, { done: false }),
//   });
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "@/components/ui/sonner";

export interface OptimisticUpdate<V> {
  queryKey: QueryKey;
  apply: (old: unknown, vars: V) => unknown;
}

/** A typed cache update; `queryKey` may be a prefix, every matching query is updated. */
export function optimistic<T, V>(queryKey: QueryKey, apply: (old: T | undefined, vars: V) => T | undefined): OptimisticUpdate<V> {
  return { queryKey, apply: apply as (old: unknown, vars: V) => unknown };
}

export interface OptimisticOptions<V, D> {
  mutationFn: (vars: V) => Promise<D>;
  updates: OptimisticUpdate<V>[];
  /** The success toast; return null for none. */
  toast?: (vars: V, data: D) => { title: string; description?: string } | null;
  /** Reverses the change on the server. When given, the toast offers Undo. */
  undo?: (vars: V, data: D) => Promise<unknown>;
  /** What the error toast says. "Nothing was changed." is always added underneath. */
  errorMessage?: string | ((err: unknown, vars: V) => string);
  /** Refetched once the server answers; defaults to the keys in `updates`. */
  invalidate?: QueryKey[];
}

type Snapshot = [QueryKey, unknown][];

export function useOptimisticMutation<V, D = unknown>(opts: OptimisticOptions<V, D>) {
  const qc = useQueryClient();
  const keys = opts.invalidate ?? opts.updates.map((u) => u.queryKey);
  const restore = (snap: Snapshot) => snap.forEach(([k, data]) => qc.setQueryData(k, data));
  const refresh = () => keys.forEach((queryKey) => qc.invalidateQueries({ queryKey }));

  return useMutation<D, unknown, V, { snapshot: Snapshot }>({
    mutationFn: opts.mutationFn,
    onMutate: async (vars) => {
      await Promise.all(opts.updates.map((u) => qc.cancelQueries({ queryKey: u.queryKey })));
      const snapshot: Snapshot = [];
      for (const u of opts.updates) {
        for (const [k, data] of qc.getQueriesData({ queryKey: u.queryKey })) {
          snapshot.push([k, data]);
          qc.setQueryData(k, u.apply(data, vars));
        }
      }
      return { snapshot };
    },
    onError: (err, vars, ctx) => {
      if (ctx) restore(ctx.snapshot);
      const msg = typeof opts.errorMessage === "function" ? opts.errorMessage(err, vars) : (opts.errorMessage ?? "Couldn't save that");
      toast.error(msg, { description: "Nothing was changed." });
    },
    onSuccess: (data, vars, ctx) => {
      const t = opts.toast?.(vars, data);
      if (!t) return;
      const undo = opts.undo;
      toast(t.title, {
        description: t.description,
        action: undo
          ? {
              label: "Undo",
              onClick: () => {
                if (ctx) restore(ctx.snapshot);
                undo(vars, data)
                  .catch(() => toast.error("Couldn't undo that", { description: "The change is still saved. Try again from the page." }))
                  .finally(refresh);
              },
            }
          : undefined,
      });
    },
    onSettled: () => refresh(),
  });
}
