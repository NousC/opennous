-- Remove the company vault / company shared-knowledge subsystem. Nous is a revenue
-- product; the shared company knowledge base (declared policies/playbooks/decisions,
-- its folder+dept+person ACL, its git mirror and PR bridge) was a different product
-- bolted on, and is being pulled out entirely. The MCP tools (search_company_knowledge,
-- propose_company_file), the /v2/company + /api/company routes, the GitHub sync bridge,
-- and the frontend vault UI are all gone in the same change; this drops the backing schema.
--
-- Scope: only the company-VAULT objects. The CRM "company"/account surface (companies,
-- foundations) and the PERSONAL vault (personal_files/personal_workspaces — the evidence
-- layer's store) are untouched. The department/workspace membership model is left in
-- place (company_departments, workspace_members.department_id, team_invitations.department_id,
-- and the add_user_to_team_workspaces() trigger): it is workspace structure, not the vault,
-- and tearing it out is a separate decision. Its admin UI is gone, so it is simply dormant.
--
-- Apply in the Supabase SQL editor (DDL). Ends with NOTIFY pgrst so the API sees it.

-- The ACL-filtered semantic-search RPC over the vault.
drop function if exists public.search_company_files(uuid, text, boolean, text, uuid, double precision, integer);
drop function if exists public.search_company_files;

-- The vault tables. CASCADE clears the embedding column, RLS policies, and indexes.
drop table if exists public.company_files          cascade;
drop table if exists public.company_folder_policy   cascade;
drop table if exists public.company_workspaces      cascade;

notify pgrst, 'reload schema';
