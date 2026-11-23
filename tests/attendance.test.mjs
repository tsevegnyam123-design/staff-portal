import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appScript=readFileSync("google-apps-script/AttendanceSync.gs","utf8");
const edge=readFileSync("supabase/functions/portal/index.ts","utf8");
const html=readFileSync("index.html","utf8");
const sql=readFileSync("database/portal_v2_attendance.sql","utf8");

assert.doesNotThrow(()=>new Function(appScript));
assert.doesNotThrow(()=>new Function(edge));
const inline=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inline);
assert.doesNotThrow(()=>new Function(inline));

const scriptFns=new Function("Utilities",appScript+
  "; return {payrollCycle_,rowFromAttendance_,duration_,safeSheetText_};")({
  formatDate(date,timezone,pattern){
    if(pattern==="yyyy-MM-dd")return date.toISOString().slice(0,10);
    const parts=new Intl.DateTimeFormat("en-GB",{
      timeZone:timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"
    }).formatToParts(date);
    const value=name=>parts.find(p=>p.type===name)?.value;
    return value("hour")+":"+value("minute");
  }
});

test("payroll cycles follow the 26th–25th across years",()=>{
  assert.deepEqual(scriptFns.payrollCycle_("2026-11-25"),{
    ym:"2026-11",from:"2026-10-26",to:"2026-11-25"
  });
  assert.deepEqual(scriptFns.payrollCycle_("2026-11-26"),{
    ym:"2026-12",from:"2026-11-26",to:"2026-12-25"
  });
  assert.deepEqual(scriptFns.payrollCycle_("2026-12-26"),{
    ym:"2027-01",from:"2026-12-26",to:"2027-01-25"
  });
});

test("employee Google Sheet shows next-day 01:00 closure as NOT a worked shift",()=>{
  const row=scriptFns.rowFromAttendance_({
    id:17,work_date:"2026-11-23",
    check_in_at:"2026-11-23T08:00:00Z",check_out_at:"2026-11-23T17:00:00Z",
    status:"auto_missing_out"
  });
  assert.deepEqual(row,["2026/11/23","16:00","01:00","-","Явсан дараагүй","17"]);
});

test("completed shift is counted only with a real checkout",()=>{
  const normal={
    id:18,work_date:"2026-11-20",
    check_in_at:"2026-11-20T06:15:00Z",
    check_out_at:"2026-11-20T09:15:00Z",status:"completed"
  };
  assert.equal(scriptFns.duration_(normal),"3:00");
  assert.equal(scriptFns.duration_({...normal,status:"auto_missing_out"}),"-");
  assert.equal(scriptFns.rowFromAttendance_(normal)[4],"Хэвийн");
});

test("never allow spreadsheet formula injection from staff names",()=>{
  assert.equal(scriptFns.safeSheetText_("=HYPERLINK(...)"),"'=HYPERLINK(...)");
  assert.equal(scriptFns.safeSheetText_("+123"),"'+123");
  assert.equal(scriptFns.safeSheetText_("Номинзул"),"Номинзул");
});

test("server and database enforce GPS on every clock action",()=>{
  assert.match(sql,/p_accuracy > 100/);
  assert.match(sql,/Outside permitted attendance location/);
  assert.match(sql,/distance_m > loc\.radius_m/);
  assert.match(sql,/check_in_at timestamptz not null/);
  assert.match(sql,/auto_due_at timestamptz not null/);
  assert.match(sql,/auto_missing_out/);
  assert.match(edge,/p_employee:user\.employee_code/);
  assert.match(edge,/const user = await current\(req\)/);
  assert.match(edge,/attendanceSetSite/);
  assert.match(edge,/attendanceClock/);
  assert.match(inline,/navigator\.geolocation\.getCurrentPosition/);
});

test("private Sheets export requires server configured long-lived secret",()=>{
  assert.match(edge,/GOOGLE_SHEETS_SYNC_TOKEN/);
  assert.match(edge,/await requireAttendanceExport\(req\)/);
  assert.match(sql,/revoke all on public\.portal_v2_attendance_sites/);
  assert.ok(!appScript.includes("SUPABASE_SERVICE_ROLE_KEY"));
  assert.match(appScript,/getProperty\("ATTENDANCE_SYNC_TOKEN"\)/);
  assert.match(appScript,/ScriptApp\.newTrigger\("synchronizeAttendance"\)/);
});

test("manager site must be configured before clock buttons are enabled",()=>{
  assert.match(inline,/!data\.configured\|\|!!open/);
  assert.match(inline,/!data\.configured\|\|!open/);
  assert.match(inline,/Явсан дараагүй/);
});
