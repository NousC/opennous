// Normalize an email touch (Gmail rawData) into a clean markdown thread. The Gmail
// poller puts the body in observations.raw as { message_id, subject, from, to, body_text,
// body_html } (apps/worker/src/pollers/gmail.mjs).
export function normalizeEmail(rawData, { type } = {}) {
  const r = rawData || {};
  const subject = r.subject || '(no subject)';
  const messageId = r.message_id || r.messageId || null;
  if (!messageId) return null;   // no stable key → skip (dedup safety)
  const body = (r.body_text || stripHtml(r.body_html) || '').trim();
  if (!body) return null;
  const dir = type === 'email_received' ? 'received' : 'sent';
  const md = [
    `# ${subject}`,
    '',
    `**${dir === 'received' ? 'From' : 'To'}:** ${dir === 'received' ? (r.from || '') : (r.to || '')}`,
    r.from && dir !== 'received' ? `**From:** ${r.from}` : null,
    '',
    body,
  ].filter((l) => l != null).join('\n');
  return { title: subject, markdown: md, dedupKey: messageId };
}

function stripHtml(html) {
  if (!html) return '';
  return String(html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}
