-- Staff Portal attendance v1. Does not alter payroll, shifts or cash tables.
-- Location is checked on server for every IN/OUT; raw employee GPS is not stored.
-- Only the manager's chosen fixed branch centre is stored.
create table if not exists public.portal_v2_attendance_sites (
  branch_code text primary key,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_m integer not null default 150 check (radius_m between 50 and 500),
  updated_by text not null references public.portal_v2_accounts(employee_code),
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_v2_attendance (
  id bigint generated always as identity primary key,
  employee_code text not null references public.portal_v2_accounts(employee_code) on delete restrict,
  work_date date not null,
  check_in_at timestamptz not null,
  check_out_at timestamptz,
  auto_due_at timestamptz not null,
  status text not null check (status in ('open','completed','auto_missing_out')),
  check_in_accuracy_m double precision,
  check_out_accuracy_m double precision,
  created_at timestamptz not null default now(),
  constraint portal_attendance_status_fields check (
    (status='open' and check_out_at is null)
    or (status in ('completed','auto_missing_out') and check_out_at is not null)
  ),
  constraint portal_attendance_time_order check (
    check_out_at is null or check_out_at >= check_in_at
  )
);
create unique index if not exists portal_v2_attendance_one_open
  on public.portal_v2_attendance(employee_code) where status='open';
create index if not exists portal_v2_attendance_employee_date
  on public.portal_v2_attendance(employee_code,work_date desc);
create index if not exists portal_v2_attendance_auto_due
  on public.portal_v2_attendance(auto_due_at) where status='open';

alter table public.portal_v2_attendance_sites enable row level security;
alter table public.portal_v2_attendance enable row level security;
revoke all on public.portal_v2_attendance_sites,
  public.portal_v2_attendance from anon, authenticated;
revoke all on sequence public.portal_v2_attendance_id_seq from anon, authenticated;

-- Make all expired "open" shifts visibly invalid at exactly the next 01:00
-- in Asia/Ulaanbaatar. Their duration does NOT count as confirmed work.
create or replace function public.portal_v2_attendance_auto_close()
returns integer language plpgsql security invoker set search_path=''
as $$
declare changed integer;
begin
  update public.portal_v2_attendance
     set check_out_at=auto_due_at,
         status='auto_missing_out'
   where status='open' and auto_due_at <= now();
  get diagnostics changed = row_count;
  return changed;
end;
$$;

create or replace function public.portal_v2_attendance_set_site(
  p_manager text, p_lat double precision,
  p_lng double precision, p_radius integer
) returns text language plpgsql security invoker set search_path=''
as $$
declare manager_row public.portal_v2_accounts%rowtype;
begin
  select * into manager_row from public.portal_v2_accounts
   where employee_code=p_manager and access_role='manager' and is_active=true;
  if not found then raise exception 'Only active managers can configure branch locations'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90
     or p_lng not between -180 and 180 or p_radius not between 50 and 500 then
    raise exception 'Invalid location or radius';
  end if;
  insert into public.portal_v2_attendance_sites
    (branch_code,latitude,longitude,radius_m,updated_by,updated_at)
  values (manager_row.branch_code,p_lat,p_lng,p_radius,p_manager,now())
  on conflict (branch_code) do update
    set latitude=excluded.latitude,longitude=excluded.longitude,
        radius_m=excluded.radius_m,updated_by=excluded.updated_by,
        updated_at=excluded.updated_at;
  return manager_row.branch_code;
end;
$$;

create or replace function public.portal_v2_attendance_clock(
  p_employee text, p_action text,
  p_lat double precision, p_lng double precision,
  p_accuracy double precision
) returns public.portal_v2_attendance
language plpgsql security invoker set search_path=''
as $$
declare
  worker public.portal_v2_accounts%rowtype;
  loc public.portal_v2_attendance_sites%rowtype;
  current_row public.portal_v2_attendance%rowtype;
  distance_m double precision;
  submitted_at timestamptz;
  local_work_date date;
  cutoff_at timestamptz;
begin
  if p_action not in ('in','out') then raise exception 'Unsupported attendance action'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90
     or p_lng not between -180 and 180 or p_accuracy is null
     or p_accuracy <= 0 or p_accuracy > 100 then
    raise exception 'A precise (100m or better) location fix is required';
  end if;
  select * into worker from public.portal_v2_accounts
    where employee_code=p_employee and is_active=true;
  if not found then raise exception 'Active employee not found'; end if;
  select * into loc from public.portal_v2_attendance_sites
    where branch_code=worker.branch_code;
  if not found then raise exception 'Branch location has not been configured'; end if;
  distance_m:=2*6371000*asin(least(1,sqrt(
    power(sin(radians(p_lat-loc.latitude)/2),2)
    +cos(radians(loc.latitude))*cos(radians(p_lat))
      *power(sin(radians(p_lng-loc.longitude)/2),2)
  )));
  if distance_m > loc.radius_m then
    raise exception 'Outside permitted attendance location';
  end if;

  -- Serialize clock actions per employee, including simultaneous devices.
  perform 1 from public.portal_v2_accounts where employee_code=p_employee for update;
  perform public.portal_v2_attendance_auto_close();
  select * into current_row from public.portal_v2_attendance
   where employee_code=p_employee and status='open'
   for update;
  submitted_at := clock_timestamp();

  if p_action='in' then
    if current_row.id is not null then
      raise exception 'You have already checked in';
    end if;
    local_work_date := (submitted_at at time zone 'Asia/Ulaanbaatar')::date;
    cutoff_at := ((local_work_date + 1)::timestamp + interval '1 hour')
      at time zone 'Asia/Ulaanbaatar';
    insert into public.portal_v2_attendance
      (employee_code,work_date,check_in_at,auto_due_at,status,check_in_accuracy_m)
    values (p_employee,local_work_date,submitted_at,cutoff_at,'open',p_accuracy)
    returning * into current_row;
  else
    if current_row.id is null then
      raise exception 'No active check-in found';
    end if;
    if submitted_at >= current_row.auto_due_at then
      perform public.portal_v2_attendance_auto_close();
      raise exception 'Checkout cutoff passed; entry marked for review';
    end if;
    update public.portal_v2_attendance
       set check_out_at=submitted_at,status='completed',
           check_out_accuracy_m=p_accuracy
     where id=current_row.id returning * into current_row;
  end if;
  return current_row;
end;
$$;

-- Do not allow direct client calls, including to privileged procedures.
revoke all on function public.portal_v2_attendance_auto_close() from public,anon,authenticated;
revoke all on function public.portal_v2_attendance_set_site(text,double precision,double precision,integer)
  from public,anon,authenticated;
revoke all on function public.portal_v2_attendance_clock(text,text,double precision,double precision,double precision)
  from public,anon,authenticated;
grant execute on function public.portal_v2_attendance_auto_close() to service_role;
grant execute on function public.portal_v2_attendance_set_site(text,double precision,double precision,integer) to service_role;
grant execute on function public.portal_v2_attendance_clock(text,text,double precision,double precision,double precision) to service_role;

-- Hourly/background auto-close via pg_cron is configured separately.
-- Until cron is enabled, clock/status/export API calls still close expired rows.
