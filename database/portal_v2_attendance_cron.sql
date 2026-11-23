-- Runs every 5 minutes; timestamps are applied as the exact next 01:00
-- Asia/Ulaanbaatar cutoff, not the scheduler execution time.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'staff-portal-attendance-auto-close',
  '*/5 * * * *',
  $$select public.portal_v2_attendance_auto_close();$$
);