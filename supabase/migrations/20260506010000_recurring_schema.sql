-- ============================================================
-- Recurring Service Tasks — Phase 1: Schema
-- ============================================================
-- Adds is_recurring flag on service_pipelines, the
-- recurring_schedules + recurring_schedule_log tables, and the
-- backstop trigger that keeps next_due_at aligned with
-- last_fired_at + interval_days.
--
-- Filename uses HHMMSS suffix so this migration applies BEFORE
-- the seed/functions/cron files (alphabetical ordering matters
-- when timestamps share a date).

-- 1. Mark recurring pipelines vs onboarding pipelines.
alter table public.service_pipelines
  add column if not exists is_recurring boolean not null default false;

-- 2. Make fn_match_pipeline_key recurring-aware so onboarding
--    services never collide with recurring pipelines (e.g. "Property
--    Inspection" should resolve to onboarding `home`, not recurring
--    `home_inspection`). Onboarding pipelines have is_recurring = false.
create or replace function public.fn_match_pipeline_key(p_service text)
returns text language plpgsql as $$
declare
  v_key text;
  v_service_lower text := lower(trim(p_service));
begin
  -- Exact pattern match (excluding recurring pipelines)
  select pipeline_key into v_key
  from public.service_pipelines
  where is_recurring = false
    and v_service_lower = any(
      select lower(unnest(service_match_patterns))
    )
  limit 1;

  if v_key is not null then return v_key; end if;

  -- Substring fallback (excluding recurring pipelines)
  select pipeline_key into v_key
  from public.service_pipelines
  where is_recurring = false
    and exists (
      select 1 from unnest(service_match_patterns) as pat
      where v_service_lower like '%' || lower(pat) || '%'
    )
  limit 1;

  return v_key;
end;
$$;

-- 3. recurring_schedules: one active schedule per (client, service).
create table if not exists public.recurring_schedules (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete cascade,
  service         text not null,
  pipeline_key    text not null
                    references public.service_pipelines(pipeline_key)
                    on update cascade,
  interval_days   int  not null default 30 check (interval_days >= 1),
  active          boolean not null default true,
  last_fired_at   timestamptz,
  next_due_at     timestamptz,
  created_by      text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique (client_id, service)
);

create index if not exists recurring_schedules_due_idx
  on public.recurring_schedules (next_due_at)
  where active = true;

create index if not exists recurring_schedules_client_idx
  on public.recurring_schedules (client_id);

alter table public.recurring_schedules enable row level security;
drop policy if exists "Full access" on public.recurring_schedules;
create policy "Full access" on public.recurring_schedules
  for all using (true) with check (true);

-- 4. recurring_schedule_log: audit trail of every fire attempt.
create table if not exists public.recurring_schedule_log (
  id            uuid primary key default gen_random_uuid(),
  schedule_id   uuid references public.recurring_schedules(id) on delete cascade,
  fired_at      timestamptz default now(),
  trigger_type  text check (trigger_type in ('cron', 'admin_manual', 'client_manual')),
  result        text check (result in (
    'success', 'skipped_inactive', 'skipped_pipeline_missing',
    'skipped_active_task', 'error'
  )),
  task_id       uuid references public.tasks(id),
  error_msg     text
);

create index if not exists recurring_schedule_log_schedule_idx
  on public.recurring_schedule_log (schedule_id, fired_at desc);

alter table public.recurring_schedule_log enable row level security;
drop policy if exists "Full access" on public.recurring_schedule_log;
create policy "Full access" on public.recurring_schedule_log
  for all using (true) with check (true);

-- 5. Backstop trigger: keep next_due_at aligned with last_fired_at + interval_days.
--    Also bumps updated_at on every write.
create or replace function public.fn_recurring_schedule_set_next_due()
returns trigger language plpgsql as $$
begin
  if NEW.next_due_at is null
     or (TG_OP = 'UPDATE' and (
          OLD.interval_days is distinct from NEW.interval_days
          or OLD.last_fired_at is distinct from NEW.last_fired_at
        ))
  then
    NEW.next_due_at := coalesce(NEW.last_fired_at, now())
                       + (NEW.interval_days * interval '1 day');
  end if;

  NEW.updated_at := now();
  return NEW;
end;
$$;

drop trigger if exists trg_recurring_schedule_set_next_due on public.recurring_schedules;
create trigger trg_recurring_schedule_set_next_due
  before insert or update on public.recurring_schedules
  for each row
  execute function public.fn_recurring_schedule_set_next_due();
