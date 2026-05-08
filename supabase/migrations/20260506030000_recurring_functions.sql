-- ============================================================
-- Recurring Service Tasks — Phase 3: Worker + Manual RPC
-- ============================================================
-- fn_fire_recurring_schedule is the worker (cron + manual call it).
-- It is idempotent per-row: advances next_due_at only on success
-- and logs every attempt (success/skipped/error) to
-- recurring_schedule_log.
--
-- fn_fire_recurring_schedule_manual is a thin RPC for admin/client
-- "Run now" buttons. SECURITY INVOKER (we deliberately do NOT use
-- SECURITY DEFINER in an exposed schema — see Supabase security
-- checklist). Authorisation is enforced at the app layer + RLS.

create or replace function public.fn_fire_recurring_schedule(
  p_schedule_id uuid,
  p_trigger_type text default 'cron'
) returns uuid language plpgsql as $$
declare
  v_sched      record;
  v_pipeline   record;
  v_active_ct  int;
  v_task_id    uuid;
begin
  -- Trigger type guard
  if p_trigger_type is null
     or p_trigger_type not in ('cron', 'admin_manual', 'client_manual') then
    p_trigger_type := 'cron';
  end if;

  -- Lock the schedule row to prevent concurrent fires
  select * into v_sched
  from public.recurring_schedules
  where id = p_schedule_id
  for update;

  if not found then
    insert into public.recurring_schedule_log
      (schedule_id, trigger_type, result, error_msg)
    values (p_schedule_id, p_trigger_type, 'error', 'schedule not found');
    return null;
  end if;

  if not v_sched.active then
    insert into public.recurring_schedule_log
      (schedule_id, trigger_type, result)
    values (p_schedule_id, p_trigger_type, 'skipped_inactive');
    return null;
  end if;

  -- Pipeline must exist (FK guarantees this on insert/update, but
  -- a manual SQL change could orphan a key — defensive check).
  select * into v_pipeline
  from public.service_pipelines
  where pipeline_key = v_sched.pipeline_key;

  if not found then
    insert into public.recurring_schedule_log
      (schedule_id, trigger_type, result, error_msg)
    values (p_schedule_id, p_trigger_type, 'skipped_pipeline_missing',
            'pipeline_key=' || v_sched.pipeline_key);
    return null;
  end if;

  -- Skip if an active (Pending/In Progress) task already exists
  -- for this client + pipeline_key combo. Prevents duplicate work
  -- when the schedule fires while the previous visit is still open.
  select count(*) into v_active_ct
  from public.tasks
  where client_id = v_sched.client_id
    and pipeline_key = v_sched.pipeline_key
    and status in ('Pending', 'In Progress');

  if v_active_ct > 0 then
    insert into public.recurring_schedule_log
      (schedule_id, trigger_type, result, error_msg)
    values (p_schedule_id, p_trigger_type, 'skipped_active_task',
            v_active_ct || ' active task(s) for client+pipeline');
    return null;
  end if;

  -- Create the task
  insert into public.tasks (client_id, service, status, progress, pipeline_key)
  values (v_sched.client_id, v_sched.service, 'Pending', 0, v_sched.pipeline_key)
  returning id into v_task_id;

  -- Build the multi-step pipeline. Recurring tasks use the full
  -- service_pipelines.steps definition, NOT the single-step fallback
  -- that onboarding tasks use (see 20260427_replicate_js_fallback).
  perform public.fn_create_task_steps(v_task_id, v_sched.pipeline_key);

  -- Auto-assign best-fit employee (no-op if none qualifies)
  perform public.fn_auto_assign_task(v_task_id);

  -- Advance schedule. The before-update trigger recomputes next_due_at.
  update public.recurring_schedules
  set last_fired_at = now()
  where id = p_schedule_id;

  insert into public.recurring_schedule_log
    (schedule_id, trigger_type, result, task_id)
  values (p_schedule_id, p_trigger_type, 'success', v_task_id);

  return v_task_id;
exception when others then
  insert into public.recurring_schedule_log
    (schedule_id, trigger_type, result, error_msg)
  values (p_schedule_id, p_trigger_type, 'error', SQLERRM);
  return null;
end;
$$;

-- Public RPC — admin "Run now" or client "Request next visit now".
-- SECURITY INVOKER (default): inherits caller's privileges. The
-- project's RLS is "Full access for all" so any authenticated user
-- can call this; gating is at the app layer (admin email allowlist
-- or own-client check in dashboard.html).
create or replace function public.fn_fire_recurring_schedule_manual(
  p_schedule_id uuid,
  p_trigger_type text default 'admin_manual'
) returns uuid language plpgsql as $$
begin
  if p_trigger_type not in ('admin_manual', 'client_manual') then
    p_trigger_type := 'admin_manual';
  end if;
  return public.fn_fire_recurring_schedule(p_schedule_id, p_trigger_type);
end;
$$;

grant execute on function public.fn_fire_recurring_schedule(uuid, text)
  to anon, authenticated, service_role;
grant execute on function public.fn_fire_recurring_schedule_manual(uuid, text)
  to anon, authenticated, service_role;
