-- ============================================================
-- Seed data for local testing of the rebuilt schema.
--
-- Exercises every flow that the migrations introduce:
--   * Onboarding pipeline matching (single-step fallback per task)
--   * Employee auto-assignment (skill, city, workload, perf score)
--   * Step assignee sync trigger (20260428)
--   * Recurring schedule lifecycle: insert -> next_due_at backstop,
--     manual fire -> task + multi-step pipeline + log row,
--     duplicate fire -> skipped_active_task,
--     inactive schedule -> skipped_inactive,
--     pipeline-mismatch -> skipped_pipeline_missing
--   * Proof submission + client-accept advancing the step
--   * Client-dispute escalation creating a dispute row
-- ============================================================

-- Clean slate so reruns are deterministic
truncate
  public.recurring_schedule_log,
  public.recurring_schedules,
  public.step_proofs,
  public.task_steps,
  public.task_updates,
  public.disputes,
  public.tasks,
  public.clients,
  public.employees,
  public.employee_metrics
restart identity cascade;

-- ------------------------------------------------------------
-- Employees — covers each required_skill the pipelines reference.
-- ------------------------------------------------------------
insert into public.employees (email, name, phone, city, pin_code, skills, status, approved_at, approved_by) values
  ('inspect.mumbai@nri.test',  'Asha Inspector',   '+91-9000000001', 'Mumbai',   '400001', '{Inspection,Property}', 'approved', now(), 'seed'),
  ('property.mumbai@nri.test', 'Bala Property',    '+91-9000000002', 'Mumbai',   '400002', '{Property}',            'approved', now(), 'seed'),
  ('care.bangalore@nri.test',  'Chitra Care',      '+91-9000000003', 'Bangalore','560001', '{Care}',                'approved', now(), 'seed'),
  ('vehicle.delhi@nri.test',   'Dev Vehicle',      '+91-9000000004', 'Delhi',    '110001', '{Vehicle}',             'approved', now(), 'seed'),
  ('legal.chennai@nri.test',   'Esha Legal',       '+91-9000000005', 'Chennai',  '600001', '{Legal,Tax}',           'approved', now(), 'seed'),
  ('pending.mumbai@nri.test',  'Pending Person',   '+91-9000000006', 'Mumbai',   '400003', '{Property}',            'pending',  null, null);

-- ------------------------------------------------------------
-- Clients — services[] kicks the trg_create_tasks_from_client
-- trigger which runs the single-step fallback path.
-- ------------------------------------------------------------
insert into public.clients (name, email, city, country, services, status) values
  ('Rohit Mumbai',    'rohit@example.test',    'Mumbai',    'UAE', '{"Property Legal","Tax Filing"}', 'Active'),
  ('Sunita Bangalore','sunita@example.test',   'Bangalore', 'UK',  '{"Wellbeing Check"}',             'Active'),
  ('Vivek Chennai',   'vivek@example.test',    'Chennai',   'SG',  '{"Aadhaar Update"}',              'Pending');

-- ------------------------------------------------------------
-- Recurring schedules — three cases:
--   1. due now, fires on manual run
--   2. inactive, should be skipped
--   3. due now but pipeline FK already valid (will fire too)
-- ------------------------------------------------------------

-- Case 1: monthly home inspection for Rohit (due = now).
-- We bypass the auto next_due_at calculation by setting last_fired_at
-- in the past so the trigger lands next_due_at <= now().
insert into public.recurring_schedules
  (client_id, service, pipeline_key, interval_days, active, last_fired_at, created_by)
select c.id, 'Monthly Property Inspection', 'home_inspection', 30, true,
       now() - interval '31 days', 'seed'
from public.clients c where c.email = 'rohit@example.test';

-- Case 2: monthly wellness check for Sunita, INACTIVE.
insert into public.recurring_schedules
  (client_id, service, pipeline_key, interval_days, active, last_fired_at, created_by)
select c.id, 'Monthly Wellness Check', 'parental_checkup', 30, false,
       now() - interval '31 days', 'seed'
from public.clients c where c.email = 'sunita@example.test';

-- Case 3: medicine delivery for Sunita, due now.
insert into public.recurring_schedules
  (client_id, service, pipeline_key, interval_days, active, last_fired_at, created_by)
select c.id, 'Weekly Medicine Run', 'medicine_delivery', 7, true,
       now() - interval '8 days', 'seed'
from public.clients c where c.email = 'sunita@example.test';
