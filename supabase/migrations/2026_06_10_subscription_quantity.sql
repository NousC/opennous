-- Subscription quantity — the per-seat count for quantity-based plans (Partner).
--
-- Partner is priced per client workspace ($100/mo each, 5 included), so its Stripe
-- subscription is a per-unit price with quantity = number of client workspaces.
-- We mirror that quantity here (synced from the Stripe webhook) so the workspace
-- create-guard can use the REAL purchased count instead of the static base of 5.
-- Every other (flat) plan stays quantity 1.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1;
