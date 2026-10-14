import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { badRecipient, revboxesRequest, type BoxDetail, type RevBox } from '@/lib/revboxes';

// Serialize writes and merge returned revisions without discarding edits typed in flight.
export function useAutosavedRevbox(incoming: RevBox | undefined, ws: string, token: string, id: string) {
  const cache = useQueryClient();
  const [box, setBox] = useState<RevBox | null>(null);
  const [edit, setEdit] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const latest = useRef<RevBox | null>(null);
  const editSeq = useRef(0);
  const savedSeq = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (incoming && editSeq.current === savedSeq.current) { latest.current = incoming; setBox(incoming); }
  }, [incoming]);

  const change = useCallback((patch: Partial<RevBox>) => {
    if (!latest.current) return;
    latest.current = { ...latest.current, ...patch };
    editSeq.current += 1;
    setBox(latest.current); setEdit(editSeq.current); setDirty(true); setSaveError('');
  }, []);

  const save = useCallback(() => {
    const operation = queue.current.catch(() => {}).then(async () => {
      const draft = latest.current;
      if (!draft || editSeq.current === savedSeq.current) return draft;
      const sequence = editSeq.current;
      setSaving(true); setSaveError('');
      try {
        const { box: updated } = await revboxesRequest<{ box: RevBox }>(ws, token, `/${id}`, { method: 'PATCH', body: JSON.stringify({ name: draft.name, objective: draft.objective, scope: draft.scope, blocks: draft.blocks, delivery: draft.delivery, ...(draft.access === 'owner' ? { shared: draft.shared } : {}), revision: draft.revision }) });
        savedSeq.current = sequence;
        latest.current = editSeq.current === sequence ? updated : { ...latest.current!, revision: updated.revision, updated_at: updated.updated_at };
        setBox(latest.current); setDirty(editSeq.current !== sequence);
        cache.setQueryData<BoxDetail>(['revbox', ws, id], old => old ? { ...old, box: updated } : old);
        await Promise.all([
          cache.invalidateQueries({ queryKey: ['revboxes', ws] }),
          cache.invalidateQueries({ queryKey: ['revbox-accounts', ws, id] }),
          cache.invalidateQueries({ queryKey: ['graph', ws, `revbox-${id}`] }),
          cache.invalidateQueries({ queryKey: ['revbox-context-library', ws] }),
        ]);
        return updated;
      } catch (e) { setSaveError(e instanceof Error ? e.message : 'Could not save changes.'); throw e; }
      finally { setSaving(false); }
    });
    queue.current = operation;
    return operation;
  }, [cache, ws, token, id]);

  useEffect(() => {
    if (!dirty || !latest.current?.name.trim()) return;
    // A partially typed URL is not a valid destination yet; save it once valid.
    if (latest.current.delivery.some(d => d.kind === 'webhook' && d.target && !/^https:\/\//.test(d.target))) return;
    // Nor is a half-typed email address (GET-868): the server refuses it.
    if (latest.current.delivery.some(d => (d.kind === 'email' && (badRecipient(d.to ?? d.target) || badRecipient(d.cc))) || (d.kind === 'gmail' && (badRecipient(d.to) || badRecipient(d.cc))))) return;
    const timer = window.setTimeout(() => { void save().catch(() => {}); }, 700);
    return () => window.clearTimeout(timer);
  }, [edit, dirty, save]);

  return { box, change, save, dirty, saving, saveError };
}
