-- Add a 'parked' entity status: excluded from the Nous product but retained in
-- Supabase for other uses (e.g. the deprecated lead-list leads, kept for a
-- separate product). resolveEntity and the contacts/companies views all filter
-- status = 'active', so a parked entity drops out of every product surface —
-- people list, query, get_context, attention, ICP scoring, identity resolution —
-- while its rows, claims, observations, identifiers, and collection membership
-- stay intact. Reversible by setting status back to 'active'.
ALTER TABLE public.entities DROP CONSTRAINT entities_status_check;
ALTER TABLE public.entities ADD CONSTRAINT entities_status_check
  CHECK (status = ANY (ARRAY['active'::text, 'merged'::text, 'archived'::text, 'parked'::text]));
