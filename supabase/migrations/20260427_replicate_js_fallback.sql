-- ============================================================
-- 20260427: Replicate JS fallback in Supabase
-- ============================================================
-- The admin.js operations board originally synthesised a single "virtual"
-- task_step per task that had no real pipeline rows — one card per task.
-- After 20260426_backfill_task_steps expanded matched services into
-- multi-step pipelines, the board started showing N cards per task,
-- which doesn't match the working model (one card = one task).
--
-- This migration mirrors the JS virtual-step logic in the database:
--   1. Multi-step rows that were never worked on (no proofs, disputes,
--      or assignment) are removed so they don't clutter the board.
--   2. Every task is guaranteed exactly one fallback task_step row whose
--      shape matches the JS virtual-step (admin.js renderOperationsBoard).
--   3. The client-insert trigger creates a single fallback step instead
--      of expanding into a service pipeline. Multi-step pipelines are
--      reserved for the recurring scheduler (20260506_*).
--
-- Steps that already have proofs, disputes, or an assigned employee are
-- preserved untouched so in-flight work isn't lost.

-- ------------------------------------------------------------
-- Helper: create a single fallback task_step from a task's own fields.
-- Mirrors the virtual-step block in admin.js renderOperationsBoard.
-- ------------------------------------------------------------
create or replace function public.fn_create_fallback_step(p_task_id uuid)
returns void language plpgsql as $$
declare
  v_task record;
  v_status text;
  v_started timestamptz;
  v_completed timestamptz;
begin
  select * into v_task from public.tasks where id = p_task_id;
  if not found then return; end if;

  -- Preserve existing real work
  if exists (select 1 from public.task_steps where task_id = p_task_id) then
    return;
  end if;

  v_status := case v_task.status
    when 'In Progress' then 'in_progress'
    when 'In Review'   then 'proof_submitted'
    when 'Completed'   then 'completed'
    else 'pending'
  end;

  v_started := case
    when v_status in ('in_progress','proof_submitted','completed')
      then coalesce(v_task.created_at, now())
    else null
  end;

  v_completed := case
    when v_status = 'completed' then coalesce(v_task.created_at, now())
    else null
  end;

  insert into public.task_steps (
    task_id, step_index, step_name, step_description,
    status, assigned_employee_email, created_at,
    started_at, completed_at
  ) values (
    p_task_id,
    0,
    coalesce(
      nullif(trim(v_task.description), ''),
      nullif(trim(v_task.service), ''),
      'Task'
    ),
    coalesce(v_task.description, ''),
    v_status,
    v_task.assigned_employee_email,
    coalesce(v_task.created_at, now()),
    v_started,
    v_completed
  );

  update public.tasks set total_steps = 1 where id = p_task_id;
end;
$$;

-- ------------------------------------------------------------
-- Roll back the multi-step backfill where no work has happened.
-- Steps with proofs, disputes, OR an assigned employee are preserved
-- so any in-flight work is safe.
-- ------------------------------------------------------------
delete from public.task_steps ts
where not exists (
  select 1 from public.step_proofs sp where sp.task_step_id = ts.id
)
and not exists (
  select 1 from public.disputes d where d.task_step_id = ts.id
)
and ts.assigned_employee_email is null;

-- ------------------------------------------------------------
-- Backfill: every task without any steps gets one fallback step
-- ------------------------------------------------------------
do $$
declare
  v_task record;
begin
  for v_task in
    select t.id from public.tasks t
    where not exists (select 1 from public.task_steps ts where ts.task_id = t.id)
  loop
    perform public.fn_create_fallback_step(v_task.id);
  end loop;
end $$;

-- Recalculate total_steps to match actual rows
update public.tasks t
set total_steps = coalesce((
  select count(*) from public.task_steps ts where ts.task_id = t.id
), 1);

-- ------------------------------------------------------------
-- Replace the client-insert trigger to use single fallback step.
-- The recurring scheduler (20260506_*) is responsible for creating
-- multi-step pipelines from service_pipelines definitions.
-- ------------------------------------------------------------
create or replace function public.fn_create_tasks_from_client()
returns trigger language plpgsql as $$
declare
  v_service text;
  v_task_id uuid;
begin
  if NEW.services is null or array_length(NEW.services, 1) is null then
    return NEW;
  end if;

  foreach v_service in array NEW.services loop
    insert into public.tasks (client_id, service, status, progress)
    values (NEW.id, v_service, 'Pending', 0)
    returning id into v_task_id;

    perform public.fn_create_fallback_step(v_task_id);
    perform public.fn_auto_assign_task(v_task_id);
  end loop;

  return NEW;
end;
$$;

drop trigger if exists trg_create_tasks_from_client on public.clients;
create trigger trg_create_tasks_from_client
  after insert on public.clients
  for each row
  when (NEW.services is not null and array_length(NEW.services, 1) > 0)
  execute function public.fn_create_tasks_from_client();
