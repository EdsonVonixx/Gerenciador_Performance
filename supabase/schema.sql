-- Vonixx Performance Center (VPC)
-- Schema isolado para ser usado dentro de um projeto Supabase existente.
-- Todas as tabelas recebem prefixo `vpc_` para evitar conflito com outros projetos.
-- Regra de retenção: sem soft delete. Exclusões feitas pelo sistema usam DELETE real.

create extension if not exists pgcrypto;

create table if not exists public.vpc_departments (
  slug text primary key,
  name text not null,
  color text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vpc_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('operacional', 'gestao')),
  department_slug text references public.vpc_departments(slug),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vpc_profiles_department_required check (
    role = 'gestao' or department_slug is not null
  )
);

create table if not exists public.vpc_indicators (
  id text primary key,
  department_slug text not null references public.vpc_departments(slug) on delete cascade,
  name text not null,
  unit text not null,
  target numeric,
  goal text not null check (goal in ('higher', 'lower', 'tracking')),
  target_label text not null default 'Meta',
  formula_type text,
  active boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_slug, name)
);

create table if not exists public.vpc_launches (
  id text primary key,
  department_slug text not null references public.vpc_departments(slug) on delete cascade,
  indicator_name text not null,
  record_date date not null,
  shift text not null check (shift in ('Comercial', 'Turno A', 'Turno B', 'Turno C', 'Turno D')),
  value numeric not null,
  unit text not null,
  formula_type text,
  formula_data jsonb not null default '{}'::jsonb,
  comment text,
  created_by uuid references public.vpc_profiles(user_id),
  updated_by uuid references public.vpc_profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vpc_launches_department_date_idx
  on public.vpc_launches (department_slug, record_date desc);

create index if not exists vpc_launches_indicator_date_idx
  on public.vpc_launches (department_slug, indicator_name, record_date desc);

create table if not exists public.vpc_action_records (
  id text primary key,
  department_slug text not null references public.vpc_departments(slug) on delete cascade,
  indicator_name text,
  type text not null check (type in ('Evidência', 'Evidencia', 'Justificativa', 'Plano de Ação', 'Plano de Acao')),
  status text not null default 'Em andamento' check (status in ('Em andamento', 'Concluída', 'Concluida')),
  owner text not null,
  due_date date,
  record_date date not null,
  description text not null,
  file_name text,
  created_by uuid references public.vpc_profiles(user_id),
  updated_by uuid references public.vpc_profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vpc_action_records_department_date_idx
  on public.vpc_action_records (department_slug, record_date desc);

create index if not exists vpc_action_records_status_idx
  on public.vpc_action_records (status);

create table if not exists public.vpc_five_s_audits (
  id text primary key,
  department_slug text not null references public.vpc_departments(slug) on delete cascade,
  audit_date date not null,
  score numeric,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references public.vpc_profiles(user_id),
  updated_by uuid references public.vpc_profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_slug, audit_date)
);

alter table public.vpc_departments enable row level security;
alter table public.vpc_profiles enable row level security;
alter table public.vpc_indicators enable row level security;
alter table public.vpc_launches enable row level security;
alter table public.vpc_action_records enable row level security;
alter table public.vpc_five_s_audits enable row level security;

grant usage on schema public to authenticated;
grant select on public.vpc_departments to authenticated;
grant select on public.vpc_indicators to authenticated;
grant select on public.vpc_profiles to authenticated;
grant select, insert, update, delete on public.vpc_launches to authenticated;
grant select, insert, update, delete on public.vpc_action_records to authenticated;
grant select, insert, update, delete on public.vpc_five_s_audits to authenticated;

drop policy if exists "vpc departments select authenticated" on public.vpc_departments;
create policy "vpc departments select authenticated"
  on public.vpc_departments
  for select
  to authenticated
  using (true);

drop policy if exists "vpc profiles select own or management" on public.vpc_profiles;
drop policy if exists "vpc profiles select own" on public.vpc_profiles;
create policy "vpc profiles select own"
  on public.vpc_profiles
  for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "vpc indicators select by department or management" on public.vpc_indicators;
create policy "vpc indicators select by department or management"
  on public.vpc_indicators
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.vpc_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_slug = vpc_indicators.department_slug
        )
    )
  );

drop policy if exists "vpc launches select by department or management" on public.vpc_launches;
create policy "vpc launches select by department or management"
  on public.vpc_launches
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.vpc_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_slug = vpc_launches.department_slug
        )
    )
  );

drop policy if exists "vpc launches write by department or management" on public.vpc_launches;
create policy "vpc launches write by department or management"
  on public.vpc_launches
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.vpc_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_slug = vpc_launches.department_slug
        )
    )
  )
  with check (
    exists (
      select 1
      from public.vpc_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_slug = vpc_launches.department_slug
        )
    )
  );

drop policy if exists "vpc action records select by department or management" on public.vpc_action_records;
create policy "vpc action records select by department or management"
  on public.vpc_action_records
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.vpc_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_slug = vpc_action_records.department_slug
        )
    )
  );

drop policy if exists "vpc action records write by department or management" on public.vpc_action_records;
create policy "vpc action records write by department or management"
  on public.vpc_action_records
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.vpc_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_slug = vpc_action_records.department_slug
        )
    )
  )
  with check (
    exists (
      select 1
      from public.vpc_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_slug = vpc_action_records.department_slug
        )
    )
  );

drop policy if exists "vpc five s audits select by department or management" on public.vpc_five_s_audits;
create policy "vpc five s audits select by department or management"
  on public.vpc_five_s_audits
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.vpc_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_slug = vpc_five_s_audits.department_slug
        )
    )
  );

drop policy if exists "vpc five s audits write by department or management" on public.vpc_five_s_audits;
create policy "vpc five s audits write by department or management"
  on public.vpc_five_s_audits
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.vpc_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_slug = vpc_five_s_audits.department_slug
        )
    )
  )
  with check (
    exists (
      select 1
      from public.vpc_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_slug = vpc_five_s_audits.department_slug
        )
    )
  );
