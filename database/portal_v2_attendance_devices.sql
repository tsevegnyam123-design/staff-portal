-- Store a concise, non-unique browser/device label separately at clock-in / clock-out.
-- These labels are untrusted hints, not hardware identifiers or employee identity evidence.
-- Do not collect or export full User-Agent, serial number, MAC or device fingerprint.
alter table public.portal_v2_attendance
  add column if not exists check_in_device text,
  add column if not exists check_out_device text;
create or replace function public.portal_v2_attendance_clock_wifi_device(
  p_employee text, p_action text, p_device text
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
  if p_device is null or length(trim(p_device)) = 0 or length(p_device)>120 then
    raise exception 'Invalid device label';
  end if;
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
      (employee_code,work_date,check_in_at,auto_due_at,status,check_in_device)
    values (p_employee,local_work_date,submitted_at,cutoff_at,'open',p_device)
    returning * into current_row;
  else
    if current_row.id is null then raise exception 'No active check-in found'; end if;
    if submitted_at >= current_row.auto_due_at then
      perform public.portal_v2_attendance_auto_close();
      raise exception 'Checkout cutoff passed; entry marked for review';
    end if;
    update public.portal_v2_attendance
       set check_out_at=submitted_at,status='completed',check_out_device=p_device
    where id=current_row.id returning * into current_row;
  end if;
  return current_row;
end;
$$;

revoke all on function public.portal_v2_attendance_clock_wifi_device(text,text,text)
  from public,anon,authenticated;
grant execute on function public.portal_v2_attendance_clock_wifi_device(text,text,text)
  to service_role;
