-- Protege os lancamentos contra sobrescrita por snapshots antigos e cria
-- rastreabilidade para toda inclusao, alteracao ou exclusao.

create schema if not exists vpc_private;
revoke all on schema vpc_private from public, anon, authenticated;

create table if not exists public.vpc_launch_audit (
  audit_id bigint generated always as identity primary key,
  launch_id text not null,
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  department_slug text not null,
  actor_id uuid,
  changed_at timestamptz not null default now(),
  old_row jsonb,
  new_row jsonb
);

create index if not exists vpc_launch_audit_launch_idx
  on public.vpc_launch_audit (launch_id, changed_at desc);

create index if not exists vpc_launch_audit_department_idx
  on public.vpc_launch_audit (department_slug, changed_at desc);

alter table public.vpc_launch_audit enable row level security;

grant select on public.vpc_launch_audit to authenticated;
grant usage, select on sequence public.vpc_launch_audit_audit_id_seq to authenticated;

drop policy if exists "vpc launch audit select management" on public.vpc_launch_audit;
create policy "vpc launch audit select management"
  on public.vpc_launch_audit
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.vpc_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.active
        and profile.role = 'gestao'
    )
  );

create or replace function public.vpc_set_audit_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  new.updated_by = coalesce(auth.uid(), new.updated_by);
  if tg_op = 'INSERT' then
    new.created_by = coalesce(new.created_by, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists vpc_launches_set_audit_fields on public.vpc_launches;
create trigger vpc_launches_set_audit_fields
before insert or update on public.vpc_launches
for each row execute function public.vpc_set_audit_fields();

create or replace function vpc_private.audit_vpc_launch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.vpc_launch_audit (
    launch_id,
    operation,
    department_slug,
    actor_id,
    old_row,
    new_row
  ) values (
    coalesce(new.id, old.id),
    tg_op,
    coalesce(new.department_slug, old.department_slug),
    auth.uid(),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;

revoke all on function vpc_private.audit_vpc_launch() from public, anon, authenticated;

drop trigger if exists vpc_launches_audit_changes on public.vpc_launches;
create trigger vpc_launches_audit_changes
after insert or update or delete on public.vpc_launches
for each row execute function vpc_private.audit_vpc_launch();

drop policy if exists "vpc launches delete by department or management" on public.vpc_launches;
drop policy if exists "vpc launches delete management" on public.vpc_launches;
create policy "vpc launches delete management"
  on public.vpc_launches
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.vpc_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.active
        and profile.role = 'gestao'
    )
  );
