// Onboarding drip copy. One entry per follow-up after the welcome email.
//
// `delayHoursFromWelcome` is measured from the welcome email (≈ signup), NOT
// from the previous send — so the cadence is day 2 / day 4 / day 7 regardless
// of when the worker happens to tick. The worker sends the next due step only.
//
// render(ctx) receives:
//   ctx.name         — first name (falls back to "there")
//   ctx.promoCode    — per-user Stripe promotion code (steps 2 & 3)
//   ctx.checkoutUrl  — where to redeem it (steps 2 & 3)
//   ctx.firstYearPrice / ctx.basePrice / ctx.discountLabel — offer economics (step 2)
//
// Steps that need an offer (2 & 3) only send once the worker has minted a code;
// see `OFFER_STEPS` in onboardingDrip.mjs. Draft copy — tune freely.

function wrap(name, paragraphs, ps) {
  const text = [`Hey ${name},`, '', paragraphs.join('\n\n'), '', 'Bennet', ...(ps ? ['', ps] : [])].join('\n');
  const body = paragraphs.map(p => `<p>${p}</p>`).join('');
  const psHtml = ps ? `<p style="color:#666;font-size:14px">${ps}</p>` : '';
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#111;max-width:560px">`
    + `<p>Hey ${name},</p>${body}<p>Bennet</p>${psHtml}</div>`;
  return { text, html };
}

export const DRIP = [
  {
    step: 1,
    delayHoursFromWelcome: 48,
    needsOffer: false,
    subject: 'how are you finding Nous?',
    render: (ctx) => wrap(ctx.name, [
      "It's been a couple of days since you signed up, so I wanted to check in.",
      "Have you had a chance to connect anything yet, or run into something that didn't make sense? Either way I'd love to hear it — and honestly, I'd love to get you on a quick call.",
      "If you're up for it, just reply to this and I'll send over my calendar link.",
    ]),
  },
  {
    step: 2,
    delayHoursFromWelcome: 96,
    needsOffer: true,
    subject: 'I made you a code (it expires in 3 days)',
    render: (ctx) => wrap(ctx.name, [
      `I just created a code that takes ${ctx.discountLabel} off the Pro plan for your first year — it brings it down to ${ctx.firstYearPrice} for the year instead of ${ctx.basePrice}.`,
      "I'm only doing this once and won't bring the offer back, so it's a genuine one-time thing. The code expires in 3 days.",
      `Your code: ${ctx.promoCode}. You can redeem it here: ${ctx.checkoutUrl}`,
      "If you've got any questions before you decide, I'm happy to help — and happy to jump on a quick call. Just reply.",
    ]),
  },
  {
    step: 3,
    delayHoursFromWelcome: 168,
    needsOffer: true,
    subject: 'your code expires today',
    render: (ctx) => wrap(ctx.name, [
      "Last note from me for now — your code expires today, so I didn't want you to miss it.",
      "And if Nous isn't clicking yet, I'd genuinely like to know why, and what would make it better for you. Even one line helps, and you're one of our first users so it really does carry weight.",
      "If now just isn't the right time, no worries at all — I'll reach back out in a few weeks once you've had more time with the platform.",
    ], `P.S. The code, one more time in case you want it: ${ctx.promoCode} — ${ctx.checkoutUrl}`),
  },
];
