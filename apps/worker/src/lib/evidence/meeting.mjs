// Normalize a meeting into a markdown file: recap on top, transcript below — the same
// content saveDocument already assembles. Called directly from the Fathom/Fireflies
// handlers (the transcript is NOT in logActivity's rawData, only in the saveDocument path).
export function normalizeMeeting({ title, recap, transcript, url }) {
  const t = title || 'Meeting';
  const parts = [`# ${t}`, ''];
  if (recap && recap.trim()) { parts.push(recap.trim(), ''); }
  if (transcript && transcript.trim()) {
    parts.push('---', '## Transcript', '', transcript.trim());
  }
  if (url) parts.push('', `[Recording](${url})`);
  // Dedup by the meeting url (stable per call) or the title — one file per meeting, even
  // when several attendees from the same account each trigger the handler.
  const dedupKey = url || `meeting:${t}`;
  return { title: t, markdown: parts.join('\n'), dedupKey };
}
