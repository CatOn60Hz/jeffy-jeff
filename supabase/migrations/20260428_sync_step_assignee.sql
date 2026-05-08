-- ============================================================
-- 20260428 — Keep task_steps.assigned_employee_email in sync
-- ============================================================
-- The operations board reads assignee from task_steps. When admin
-- changes (or clears) the assignee on a task via the edit modal,
-- only the tasks row is updated — task_steps is left stale, so the
-- card stays under the old employee and never lands in Unassigned.
--
-- This migration adds a trigger that propagates any change on
-- tasks.assigned_employee_email to all of that task's non-finalised
-- steps, and runs a one-shot resync to fix existing drift.

create or replace function public.fn_sync_step_assignee()
returns trigger language plpgsql as $$
begin
  update public.task_steps
  set assigned_employee_email = NEW.assigned_employee_email
  where task_id = NEW.id
    and status not in ('completed', 'admin_resolved')
    and assigned_employee_email is distinct from NEW.assigned_employee_email;
  return NEW;
end;
$$;

drop trigger if exists trg_sync_step_assignee on public.tasks;
create trigger trg_sync_step_assignee
  after update of assigned_employee_email on public.tasks
  for each row
  when (NEW.assigned_employee_email is distinct from OLD.assigned_employee_email)
  execute function public.fn_sync_step_assignee();

-- Heal current drift between tasks and task_steps
update public.task_steps ts
set assigned_employee_email = t.assigned_employee_email
from public.tasks t
where ts.task_id = t.id
  and ts.status not in ('completed', 'admin_resolved')
  and ts.assigned_employee_email is distinct from t.assigned_employee_email;
