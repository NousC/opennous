# Product events

The events Nous Cloud sends to its own PostHog project, so we can see a signup become an active
workspace and a paying one (GET-820). Self-hosted and open-source instances send none of them.

Two rules hold for every event:

- **Never customer content.** Event names, our own ids (user, workspace), plan ids, provider
  names and counts. No email bodies, transcript text, account names or contact details. The
  signed-up person's email and name are set on their PostHog person, nothing else.
- **object_verb, snake_case.** Add an event here before sending it; `PRODUCT_EVENTS` in
  `apps/api/src/lib/productEvents.mjs` and `BrowserProductEvent` in
  `apps/frontend/src/lib/posthog.ts` refuse anything not listed.

## Server events

Sent by the API when the thing happens (`captureProductEvent`). They do not depend on cookie
consent: no cookie is set and nothing is read from the browser. The distinct id is `users.id`,
the same id the browser identifies with, so both halves land on one person.

| Event | When | Properties |
|---|---|---|
| `signed_up` | A new founder account and its team are created (`ensureUserAndTeam`) | `workspace_id`; sets `email`, `name` |
| `invite_accepted` | An invited person's account is created on the team that invited them | sets `email`, `name` |
| `workspace_created` | A workspace is created, at signup or later | `source` (`signup` \| `manual`), `workspace_id` |
| `integration_connected` | A connection is saved after its key passed the live test | `provider`, `category`, `workspace_id` |
| `backfill_started` | The customer confirms the history backfill | `window_days`, `workspace_id` |
| `onboarding_completed` | Onboarding is stamped complete, once per workspace | `workspace_id` |
| `api_key_created` | An API key is created in the app | `workspace_id` |
| `invite_sent` | A teammate invitation is created | `role` |
| `plan_purchased` | The first paid plan goes active (Stripe webhook) | `plan`, `interval` |
| `app_active` | The first signed-in app request of a user's UTC day, at most once a day | `workspace_id`; sets `email` |

## Browser events

Sent by the app with `trackProductEvent`, only after the visitor accepted cookies.

| Event | When | Properties |
|---|---|---|
| `account_record_opened` | An account page opens | `workspace_id` |
| `automation_enabled` | An automation is switched on | `built_in`, `workspace_id` |
| `plan_checkout_started` | Stripe Checkout is opened for a plan | `plan`, `interval` |

## The funnels this answers

- **Activation:** `signed_up` → `integration_connected` → `backfill_started` → `onboarding_completed`.
- **Paid:** `signed_up` → `plan_checkout_started` → `plan_purchased`.
- **Use:** `account_record_opened` and `automation_enabled` per active workspace.

## Our own workspace

Our PostHog project is connected to our own Nous workspace as a source (GET-751). The
`signed_up` event reaches it through the destination and puts each new signup on People with
their company, within seconds.
