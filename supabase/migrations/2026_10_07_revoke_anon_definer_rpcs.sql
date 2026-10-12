-- Four SECURITY DEFINER functions were executable by anon and authenticated through
-- /rest/v1/rpc, so anyone with the public anon key could force full list recomputes for any
-- workspace (refresh_entity_list_rows runs with a 600 s timeout) or read entity ids
-- (list_rows_missing_ids). Found on prod 2026-10-07 with has_function_privilege; only the API
-- and worker call these, with the service role. Same fix as 2026_08_17_revoke_anon_execute_phase4.
REVOKE EXECUTE ON FUNCTION public.refresh_entity_list_rows(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_list_rows_for(uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.list_rows_missing_ids(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_team_account_usage(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_entity_list_rows(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_list_rows_for(uuid, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_rows_missing_ids(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_team_account_usage(uuid) TO service_role;

-- Check (expect four rows, all false):
-- select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
-- and p.proname in ('refresh_entity_list_rows','refresh_list_rows_for','list_rows_missing_ids','refresh_team_account_usage');
