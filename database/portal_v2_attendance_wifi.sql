-- Branch Wi-Fi public IPv4 allowlist, 2026-11-28.
-- Only attendance clock-in/out is restricted. Other portal operations unchanged.
-- IP address is not an SSID: a dynamic IP needs updating if ISP rotates it.
create table if not exists public.portal_v2_attendance_allowed_ips (
  branch_code text primary key,
  allowed_ipv4 inet not null,
  updated_at timestamptz not null default now(),
  constraint attendance_ipv4_only check (family(allowed_ipv4)=4 and masklen(allowed_ipv4)=32)
);
alter table public.portal_v2_attendance_allowed_ips enable row level security;
revoke all on public.portal_v2_attendance_allowed_ips from anon,authenticated;
-- Only server service role can retrieve allowlist; no browser access.
insert into public.portal_v2_attendance_allowed_ips(branch_code,allowed_ipv4)
values ('Нарны Титэм','112.72.7.161'::inet)
on conflict (branch_code) do update set
  allowed_ipv4=excluded.allowed_ipv4,updated_at=now();

-- Server-only alternative to the old GPS-based attendance function.
-- The Edge Function must first verify the authenticated staff account's branch
-- and its request IP against the allowlist; the browser cannot call this SQL RPC.
create or replace function public.portal_v2_attendance_clock_wifi(
  p_employee text, p_action text
) returns public.portal_v2_attendance
language plpgsql security invoker set search_path=''
as $$
declare
  worker public.portal_v2_accounts%rowtype;
  current_row public.portal_v2_attendance%rowtype;
  submitted_at timestamptz;
  local_work_date date;
  cutoff_at timestamptz;
begin
  if p_action is null or p_action not in ('in','out') then
    raise exception 'Unsupported attendance action';
  end if;

  -- Serialize concurrent tabs and devices.
  select * into worker from public.portal_v2_accounts
   where employee_code=p_employee and is_active=true for update;
  if not found then raise exception 'Active employee not found'; end if;
  if not exists (
    select 1 from public.portal_v2_attendance_allowed_ips
    where branch_code=worker.branch_code
  ) then raise exception 'Approved Wi-Fi not configured'; end if;

  perform public.portal_v2_attendance_auto_close();
  select * into current_row from public.portal_v2_attendance
   where employee_code=p_employee and status='open' for update;
  submitted_at:=clock_timestamp();

  if p_action='in' then
    if current_row.id is not null then raise exception 'You have already checked in'; end if;
    local_work_date := (submitted_at at time zone 'Asia/Ulaanbaatar')::date;
    cutoff_at := ((local_work_date + 1)::timestamp + interval '1 hour')
      at time zone 'Asia/Ulaanbaatar';
    insert into public.portal_v2_attendance
      (employee_code,work_date,check_in_at,auto_due_at,status)
    values (p_employee,local_work_date,submitted_at,cutoff_at,'open')
    returning * into current_row;
  else
    if current_row.id is null then raise exception 'No active check-in found'; end if;
    if submitted_at >= current_row.auto_due_at then
      perform public.portal_v2_attendance_auto_close();
      raise exception 'Checkout cutoff passed; entry marked for review';
    end if;
    update public.portal_v2_attendance
       set check_out_at=submitted_at,status='completed'
    where id=current_row.id returning * into current_row;
  end if;
  return current_row;
end;
$$;
revoke all on function public.portal_v2_attendance_clock_wifi(text,text)
 from public,anon,authenticated;
grant execute on function public.portal_v2_attendance_clock_wifi(text,text)
 to service_role;
