-- Security fix (audit H1): the v1-compat views were owned by postgres and ran as owner, bypassing
-- the RLS on the base tables — so the public anon key read ALL company + contact data via PostgREST
-- (companies returned every row; contacts returned PII). security_invoker=on makes each view run as
-- the CALLER, so the base-table RLS applies (anon has auth.uid()=null -> denied). The app reads via
-- service_role, which bypasses RLS, so it is unaffected. Verified: anon read -> [], service_role -> full.
alter view public.companies  set (security_invoker = on);
alter view public.contacts   set (security_invoker = on);
alter view public.leads      set (security_invoker = on);
alter view public.lead_lists set (security_invoker = on);
