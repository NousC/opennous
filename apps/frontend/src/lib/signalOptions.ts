// What the signal pickers offer (GET-892): the Job Builder's Signals menu and Settings > Signals list
// only the meeting recorders the workspace has connected (the catalog's meeting.done providers, which
// /api/signals/catalog already narrows), and the New signal dialog's Sources only connected tools.
// Text only: no provider logos. Pure, so tests/signalOptions.test.ts can pin it.

export const RECORDER_NAMES: Record<string, string> = { granola: 'Granola', fireflies: 'Fireflies', fathom: 'Fathom' };
export const MEETING_ANY_LABEL = 'Meeting done (any recorder)';
export const MEETING_CONNECT_HINT = 'Connect Granola, Fireflies or Fathom to use meeting signals';
/** Where a recorder is connected: recorders are personal integrations. */
export const MEETING_CONNECT_HREF = '/integrations';
/** Every source a custom signal can read, in the order the dialog shows them. */
export const SIGNAL_SOURCES = ['granola', 'fireflies', 'fathom', 'gmail', 'hubspot', 'slack'];

type MeetingEntry = { key: string; label: string; providers?: string[] };

/**
 * The meeting options of a picker: one per connected recorder ("Meeting done · Granola"), then any
 * recorder when at least one is connected. [] when none is: the picker then shows the connect hint.
 */
export function meetingSignalOptions(entry?: MeetingEntry | null): { key: string; label: string }[] {
  if (!entry) return [];
  const recorders = (entry.providers ?? []).filter(p => p !== 'any');
  if (!recorders.length) return [];
  return [
    ...recorders.map(p => ({ key: `${entry.key}:${p}`, label: `${entry.label} · ${RECORDER_NAMES[p] ?? p}` })),
    { key: entry.key, label: MEETING_ANY_LABEL },
  ];
}

/**
 * The New signal dialog's Sources: the connected ones, plus any the signal already reads (so they can
 * be turned off). `connected` undefined (an older server) offers them all.
 */
export function signalSourceChoices(connected: string[] | undefined, selected: string[] = []): string[] {
  if (!connected) return SIGNAL_SOURCES;
  const have = new Set([...connected, ...selected]);
  return SIGNAL_SOURCES.filter(s => have.has(s));
}
