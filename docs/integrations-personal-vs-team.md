# Integrations page — personal vs team-shared (UI spec)

Every source is one of two kinds. The Integrations page (and the underlying config) should reflect it,
because it drives permissions, onboarding, and what the reports can honestly claim.

## The two kinds

**Team-shared** — the account / deal / revenue layer. Configured **once by an admin/founder**, applies
to the whole workspace (these are already the team's systems of record):
- CRM (HubSpot / Attio / Pipedrive / Salesforce), Stripe, outbound (Instantly / HeyReach / Smartlead /
  Lemlist / EmailBison), Slack.
- One connection lights up the **whole team's accounts + owners + stages** immediately.

**Personal** — the conversation layer. Connected **by each member on their own tokens**:
- Meeting notetaker (Fireflies / Granola / Fathom), Gmail / Outlook, Calendar, LinkedIn.
- Fills in **seat by seat**; identity resolution merges each rep's conversations onto the shared
  accounts.

## UI

Split the Integrations page into two sections:

1. **Team integrations (shared)** — CRM · Stripe · Outbound · Slack.
   - **Admins/founders**: full connect/configure.
   - **Members**: shown as read-only ("Connected by your workspace") — they see what's wired, cannot
     change it. Never prompt a member to connect the CRM.

2. **My integrations (personal)** — Notetaker · Email · Calendar · LinkedIn.
   - Every member connects their own; scoped to that member's seat.

## Permissions
- Configuring a **team-shared** integration requires `owner`/`admin` role.
- A **personal** integration is always the acting member's own (scoped to their `user_id`).

## Why it matters beyond the UI
- **Onboarding is role-aware**: an admin connects the team-shared backbone; a member connects personal
  sources and inherits the team's shared ones (they don't re-connect the CRM). See the plugin's
  `onboard` Phase B + `references/integrations-personal-vs-team.md`.
- **Reports are precise about coverage**: a CRM (team-shared) shows every account + owner, including
  accounts owned by a rep who hasn't onboarded; that rep's *conversations* are missing until they
  backfill their personal sources. The per-seat Revenue Report §7 and the `team-report` skill both rely
  on this distinction to state coverage honestly.

## Data model note
Team-shared connections are workspace-scoped (one row per workspace per provider). Personal connections
are member-scoped (keyed by `user_id` + provider). Backfill/ingest attributes conversation activity to
the connecting member (`relationship_owner`), so the team roll-up can show per-rep coverage.
