-- Postgres cannot alter an existing function's RETURNS TABLE signature in place.
-- Remove only the service-only export function (no data is deleted).
drop function if exists public.portal_v2_attendance_export(integer,integer);
-- Server-only paged attendance export for the scheduled Google Sheets bridge.
-- Does not export employee GPS, PIN, or session tokens.
create or replace function public.portal_v2_attendance_export(
 p_offset integer default 0, p_limit integer default 300
) returns table (
 id bigint, employee_code text, display_name text, branch_code text,
 work_date date, check_in_at timestamptz, check_out_at timestamptz,
 status text, check_in_device text, check_out_device text
) language sql stable security invoker set search_path=''
as $$
 select t.id,t.employee_code,a.display_name,a.branch_code,t.work_date,
   t.check_in_at,t.check_out_at,t.status,t.check_in_device,t.check_out_device
 from public.portal_v2_attendance t
 join public.portal_v2_accounts a on a.employee_code=t.employee_code
 where p_offset >= 0 and p_limit between 1 and 500
 order by t.id
 limit p_limit offset p_offset
$$;
revoke all on function public.portal_v2_attendance_export(integer,integer)
 from public, anon, authenticated;
grant execute on function public.portal_v2_attendance_export(integer,integer)
 to service_role;
