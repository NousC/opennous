// Canonical transactional email sender — the single Resend call shared by the
// welcome email (apps/api) and the onboarding drip worker (apps/worker), so the
// from/reply-to defaults, error shape, and logging never drift apart.
//
// Plain transactional sends only — no marketing chrome. Callers own the copy
// (subject/text/html) and any idempotency guard. No-ops without RESEND_API_KEY,
// mirroring the best-effort pattern used everywhere else (dogfood, pollers).

// The shipped default is a neutral role address, not a personal inbox, so an
// OSS/self-host build never sends as a founder's email. The cloud sets its own
// RESEND_FROM_EMAIL / RESEND_REPLY_TO; self-hosters set theirs to a verified
// domain. Reply-to falls back to the from address rather than a hardcoded inbox.
const DEFAULT_FROM = process.env.RESEND_FROM_EMAIL || 'Nous <noreply@opennous.cloud>';
const DEFAULT_REPLY_TO = process.env.RESEND_REPLY_TO || DEFAULT_FROM;

export interface SendEmailParams {
  /** One address, or several (all on the To line). */
  to: string | string[];
  /** Everyone else who should see it, on the same thread. */
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
  /** Files to send with it. `content` is base64, as Resend wants it. */
  attachments?: { filename: string; content: string }[];
  /** Log tag so each caller is identifiable in worker/api logs. */
  tag?: string;
}

export interface SendEmailResult {
  sent: boolean;
  id?: string;
  reason?: 'not_configured' | 'no_recipient' | 'resend_error' | 'exception';
  status?: number;
}

export async function sendEmail({
  to,
  cc,
  subject,
  text,
  html,
  attachments,
  from = DEFAULT_FROM,
  replyTo = DEFAULT_REPLY_TO,
  tag = 'EMAIL',
}: SendEmailParams): Promise<SendEmailResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(`[${tag}] RESEND_API_KEY not set, skipping`);
    return { sent: false, reason: 'not_configured' };
  }
  if (!to) return { sent: false, reason: 'no_recipient' };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        // Cc, so everyone who needs to see it is on ONE thread and a reply-all reaches the
        // room. Sending each person their own copy is three conversations (GET-426).
        ...(cc?.length ? { cc } : {}),
        reply_to: replyTo,
        subject,
        text,
        ...(html ? { html } : {}),
        // The report travels WITH the mail. A link alone fails the one reader who is not
        // signed in, and an attachment alone cannot be discussed in the app — so both.
        ...(attachments?.length ? { attachments } : {}),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[${tag}] Resend ${res.status}: ${errText}`);
      return { sent: false, reason: 'resend_error', status: res.status };
    }
    const data: any = await res.json().catch(() => ({}));
    console.log(`[${tag}] sent to ${to} (id=${data?.id || 'unknown'})`);
    return { sent: true, id: data?.id };
  } catch (err: any) {
    console.error(`[${tag}] exception:`, err.message);
    return { sent: false, reason: 'exception' };
  }
}
