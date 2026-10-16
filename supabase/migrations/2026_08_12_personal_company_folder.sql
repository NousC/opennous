-- 'company' joins the personal-vault foundation folders (sits under content). It is
-- the member's own notes ABOUT their company — personal, not the shared company graph.
alter table public.personal_files drop constraint if exists personal_files_folder_check;
alter table public.personal_files add constraint personal_files_folder_check
  check (folder in ('inbox','thoughts','decisions','projects','briefs','content','company'));
