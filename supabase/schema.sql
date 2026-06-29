-- Vonixx Performance Center (VPC)
-- Base inicial para Supabase PostgreSQL.
-- Execute este arquivo no SQL Editor de um projeto Supabase novo.
-- Nao contem dados de teste.

create extension if not exists pgcrypto;

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  color text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('operacional', 'gestao')),
  department_id uuid references public.departments(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_department_required check (
    role = 'gestao' or department_id is not null
  )
);

create table if not exists public.indicators (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
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
  unique (department_id, name)
);

create table if not exists public.launches (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  indicator_id uuid not null references public.indicators(id) on delete restrict,
  record_date date not null,
  shift text not null check (shift in ('Comercial', 'Turno A', 'Turno B', 'Turno C', 'Turno D')),
  value numeric not null,
  unit text not null,
  formula_type text,
  formula_data jsonb not null default '{}'::jsonb,
  comment text,
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists launches_department_date_idx
  on public.launches (department_id, record_date desc);

create index if not exists launches_indicator_date_idx
  on public.launches (indicator_id, record_date desc);

create table if not exists public.action_records (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  indicator_id uuid references public.indicators(id) on delete set null,
  type text not null check (type in ('Evidencia', 'Justificativa', 'Plano de Acao')),
  status text not null default 'Em andamento' check (status in ('Em andamento', 'Concluida')),
  owner text not null,
  due_date date,
  record_date date not null,
  description text not null,
  file_name text,
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists action_records_department_date_idx
  on public.action_records (department_id, record_date desc);

create index if not exists action_records_status_idx
  on public.action_records (status);

create table if not exists public.five_s_checklist_items (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  sense text not null,
  area text not null,
  checkpoint text not null,
  weight numeric not null default 1,
  critical boolean not null default false,
  active boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.five_s_audits (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  audit_date date not null,
  score numeric,
  answered integer not null default 0,
  total integer not null default 0,
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_id, audit_date)
);

create table if not exists public.five_s_answers (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.five_s_audits(id) on delete cascade,
  checklist_item_id uuid not null references public.five_s_checklist_items(id) on delete restrict,
  score integer check (score between 0 and 4),
  evidence text,
  action text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (audit_id, checklist_item_id)
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  department_id uuid references public.departments(id) on delete set null,
  actor_id uuid references public.profiles(id) on delete set null,
  entity text not null,
  entity_id uuid,
  action text not null,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

alter table public.departments enable row level security;
alter table public.profiles enable row level security;
alter table public.indicators enable row level security;
alter table public.launches enable row level security;
alter table public.action_records enable row level security;
alter table public.five_s_checklist_items enable row level security;
alter table public.five_s_audits enable row level security;
alter table public.five_s_answers enable row level security;
alter table public.audit_events enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

create policy "departments select by authenticated users"
  on public.departments
  for select
  to authenticated
  using (true);

create policy "profiles select own or management"
  on public.profiles
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1
      from public.profiles manager
      where manager.id = (select auth.uid())
        and manager.role = 'gestao'
        and manager.active
    )
  );

create policy "indicators select own department or management"
  on public.indicators
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_id = indicators.department_id
        )
    )
  );

create policy "launches select own department or management"
  on public.launches
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_id = launches.department_id
        )
    )
  );

create policy "launches insert own department"
  on public.launches
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and profile.department_id = launches.department_id
    )
  );

create policy "launches update own department"
  on public.launches
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and profile.department_id = launches.department_id
    )
  )
  with check (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and profile.department_id = launches.department_id
    )
  );

create policy "launches delete own department"
  on public.launches
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and profile.department_id = launches.department_id
    )
  );

create policy "action records select own department or management"
  on public.action_records
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_id = action_records.department_id
        )
    )
  );

create policy "action records write own department"
  on public.action_records
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and profile.department_id = action_records.department_id
    )
  )
  with check (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and profile.department_id = action_records.department_id
    )
  );

create policy "five s checklist select own department or management"
  on public.five_s_checklist_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_id = five_s_checklist_items.department_id
        )
    )
  );

create policy "five s audits select own department or management"
  on public.five_s_audits
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_id = five_s_audits.department_id
        )
    )
  );

create policy "five s audits write own department"
  on public.five_s_audits
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and profile.department_id = five_s_audits.department_id
    )
  )
  with check (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and profile.department_id = five_s_audits.department_id
    )
  );

create policy "five s answers select through audit access"
  on public.five_s_answers
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.five_s_audits audit
      join public.profiles profile on profile.id = (select auth.uid())
      where audit.id = five_s_answers.audit_id
        and profile.active
        and (
          profile.role = 'gestao'
          or profile.department_id = audit.department_id
        )
    )
  );

create policy "five s answers write through own department audit"
  on public.five_s_answers
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.five_s_audits audit
      join public.profiles profile on profile.id = (select auth.uid())
      where audit.id = five_s_answers.audit_id
        and profile.active
        and profile.department_id = audit.department_id
    )
  )
  with check (
    exists (
      select 1
      from public.five_s_audits audit
      join public.profiles profile on profile.id = (select auth.uid())
      where audit.id = five_s_answers.audit_id
        and profile.active
        and profile.department_id = audit.department_id
    )
  );

create policy "audit events select management only"
  on public.audit_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.active
        and profile.role = 'gestao'
    )
  );
