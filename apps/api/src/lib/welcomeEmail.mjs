// Personal-feel welcome email sent once per user after they finish onboarding.
// Plain text + minimal HTML — no logo banner, no marketing chrome.
//
// The actual Resend call lives in @nous/core (sendEmail) so the welcome email
// and the onboarding drip worker share one sender. This module owns only the copy.

import { sendEmail } from '@nous/core';

function render({ firstName }) {
  const name = (firstName || 'there').toString().trim() || 'there';
  const text = `Hey ${name},

I just saw you signed up. Really glad to have you here.

As you might know, we just launched, so I apologize in advance if you run into any bugs. If you hit one, let me know ASAP so I can fix it. Same if you have an improvement or an idea, I would love to hear it.

You're one of our early users, which means a lot to us. You will be part of shaping this product.

Excited to see what you do with Nous and how it helps your GTM.

Bennet

P.S. If you're wondering how to get started, check out the resources on the website, especially the use cases and Claude skills built for you to get going.`;

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#111;max-width:560px">
<p>Hey ${name},</p>
<p>I just saw you signed up. Really glad to have you here.</p>
<p>As you might know, we just launched, so I apologize in advance if you run into any bugs. If you hit one, let me know ASAP so I can fix it. Same if you have an improvement or an idea, I would love to hear it.</p>
<p>You're one of our early users, which means a lot to us. You will be part of shaping this product.</p>
<p>Excited to see what you do with Nous and how it helps your GTM.</p>
<p>Bennet</p>
<p style="color:#666;font-size:14px">P.S. If you're wondering how to get started, check out the resources on the website, especially the use cases and Claude skills built for you to get going.</p>
</div>`;

  return { subject: `welcome, ${name}`, text, html };
}

export async function sendWelcomeEmail({ to, firstName }) {
  // This is our cloud onboarding copy, signed personally and pointing at our
  // website's resources — it must never go to a self-hoster's own users, even
  // if they configure RESEND_API_KEY for team invites.
  if (process.env.SELF_HOSTED === 'true') return { sent: false, reason: 'self_hosted' };
  const { subject, text, html } = render({ firstName });
  return sendEmail({ to, subject, text, html, tag: 'WELCOME_EMAIL' });
}
