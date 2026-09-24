-- Reliability hardening for Vonixx Performance Center.
-- Idempotent: safe to apply more than once.

create index if not exists vpc_launches_updated_at_idx
  on public.vpc_launches (updated_at desc);

create index if not exists vpc_action_records_updated_at_idx
  on public.vpc_action_records (updated_at desc);

create index if not exists vpc_five_s_audits_updated_at_idx
  on public.vpc_five_s_audits (updated_at desc);

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

drop trigger if exists vpc_action_records_set_audit_fields on public.vpc_action_records;
create trigger vpc_action_records_set_audit_fields
before insert or update on public.vpc_action_records
for each row execute function public.vpc_set_audit_fields();

drop trigger if exists vpc_five_s_audits_set_audit_fields on public.vpc_five_s_audits;
create trigger vpc_five_s_audits_set_audit_fields
before insert or update on public.vpc_five_s_audits
for each row execute function public.vpc_set_audit_fields();

update public.vpc_launches
set
  indicator_name = 'Índice de Perdas por Ajuste nos Picks Secos',
  updated_at = now()
where department_slug = 'secos'
  and indicator_name = 'Índice de Perdas por Ajuste no Picks Secos';
