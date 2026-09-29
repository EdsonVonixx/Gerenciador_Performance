-- Blocks future duplicate results without deleting or changing historical data.
-- A duplicate has the same department, indicator, date and shift.

create or replace function public.vpc_reject_duplicate_launch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      new.department_slug || '|' || new.indicator_name || '|' || new.record_date::text || '|' || new.shift,
      0
    )
  );

  if exists (
    select 1
    from public.vpc_launches existing
    where existing.id <> new.id
      and existing.department_slug = new.department_slug
      and existing.indicator_name = new.indicator_name
      and existing.record_date = new.record_date
      and existing.shift = new.shift
  ) then
    raise sqlstate 'PT409'
      using message = 'Lançamento duplicado bloqueado: já existe um resultado para este departamento, indicador, data e turno.';
  end if;
  return new;
end;
$$;

drop trigger if exists vpc_launches_reject_duplicate on public.vpc_launches;
create trigger vpc_launches_reject_duplicate
before insert or update of department_slug, indicator_name, record_date, shift
on public.vpc_launches
for each row execute function public.vpc_reject_duplicate_launch();
