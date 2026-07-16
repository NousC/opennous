-- Skill download counter — the install-count social proof on the marketing
-- site's /resources/skills. The copy button POSTs an increment; the page reads
-- the counts. Public, unauthenticated (a vanity metric), real counts only.
-- Safe to re-run.

create table if not exists skill_downloads (
  slug       text        primary key,
  count      bigint      not null default 0,
  updated_at timestamptz not null default now()
);

-- Atomic increment so concurrent copies don't drop counts.
create or replace function increment_skill_download(p_slug text)
returns bigint
language plpgsql
as $$
declare new_count bigint;
begin
  insert into skill_downloads (slug, count) values (p_slug, 1)
  on conflict (slug) do update
    set count = skill_downloads.count + 1, updated_at = now()
  returning count into new_count;
  return new_count;
end;
$$;
