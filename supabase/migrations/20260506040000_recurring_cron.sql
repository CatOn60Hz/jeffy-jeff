-- ============================================================
-- Recurring Service Tasks — Phase 4: pg_cron Registration
-- ============================================================
-- Daily at 02:00 UTC (07:30 IST). Fires every active schedule
-- whose next_due_at has passed.
--
-- pg_cron is only available on Supabase hosted projects, NOT in
-- local development. We try to load it; if unavailable (local
-- Postgres without pg_cron) the migration logs a notice and
-- continues so `supabase db reset` succeeds end-to-end.
--
-- The cron query uses FOR UPDATE SKIP LOCKED inside the worker
-- (set in 20260506030000_recurring_functions.sql) so concurrent
-- triggers do not double-fire a schedule.

do $cron_register$
begin
  -- Try to enable pg_cron. Swallow errors so this migration is
  -- safe in environments where the extension isn't installed.
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron not available in this environment (%) — skipping cron registration. Manual fires still work.', SQLERRM;
    return;
  end;

  -- Idempotent re-registration
  if exists (select 1 from cron.job where jobname = 'fire-recurring-schedules') then
    perform cron.unschedule('fire-recurring-schedules');
  end if;

  perform cron.schedule(
    'fire-recurring-schedules',
    '0 2 * * *',
    $cron$
      select public.fn_fire_recurring_schedule(s.id, 'cron')
      from (
        select id
        from public.recurring_schedules
        where active = true
          and next_due_at <= now()
        for update skip locked
      ) s;
    $cron$
  );
end
$cron_register$;
