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
  "; return {payrollCycle_,rowFromAttendance_,duration_,dayNightMinutes_,safeSheetText_,syncInfo_};")({
  formatDate(date,timezone,pattern){
    if(pattern==="yyyy-MM-dd")return date.toISOString().slice(0,10);
    if(pattern==="Z")return "+0800";
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
  assert.deepEqual(row,["2026/11/23","16:00","01:00","-","Явсан дараагүй","-","-","17"]);
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
  assert.deepEqual(scriptFns.dayNightMinutes_(normal),{total:180,day:180,night:0});
});

test("Info counts distinct completed days and ignores invalid checkout durations",()=>{
  let written=[];
  const info={
    getLastRow(){return 2;},
    getMaxRows(){return 1000;},
    getMaxColumns(){return 12;},
    setColumnWidths(){},
    getRange(_a,_b,_c,_d){return {
      clearContent(){},
      setValues(rows){if(rows.length===1 && rows[0].length===2)return;written=rows;},
      setBackground(){return this;},
      setFontColor(){return this;},
      setFontWeight(){return this;}
    };}
  };
  const spreadsheet={getSheetByName(name){return name==="Info"?info:null;}};
  const base={
    employee_code:"123204",display_name:"Номинзул",branch_code:"Нарны Титэм",
    work_date:"2026-11-23",status:"completed",
    check_in_at:"2026-11-23T08:00:00Z",check_out_at:"2026-11-23T10:00:00Z"
  };
  const second={...base,id:2,check_in_at:"2026-11-23T11:00:00Z",check_out_at:"2026-11-23T14:00:00Z"};
  const missing={...base,id:3,work_date:"2026-11-24",status:"auto_missing_out",
    check_in_at:"2026-11-24T08:00:00Z",check_out_at:"2026-11-24T17:00:00Z"};
  scriptFns.syncInfo_(spreadsheet,[base,second,missing]);
  assert.equal(written.length,1);
  assert.equal(written[0][0],"2026-11");
  assert.equal(written[0][6],1,"same-date completed sessions count as one workday");
  assert.equal(written[0][7],"5:00","only real checkout durations are counted");
  assert.equal(written[0][8],1);
  assert.equal(written[0][10],"5:00");
  assert.equal(written[0][11],"0:00");
});

test("22:00–06:00 night split works across midnight and early mornings",()=>{
  function split(start,end){
    return scriptFns.dayNightMinutes_({
      status:"completed",check_in_at:start,check_out_at:end
    });
  }
  // Asia/Ulaanbaatar is UTC+8 in 2026: 21:00->07:00 local = 2h day + 8h night.
  assert.deepEqual(split("2026-11-23T13:00:00Z","2026-11-23T23:00:00Z"),
    {total:600,day:120,night:480});
  // 21:30->23:30 local = 30m day, 90m night.
  assert.deepEqual(split("2026-11-23T13:30:00Z","2026-11-23T15:30:00Z"),
    {total:120,day:30,night:90});
  // 23:00->02:00 next day local = 3h night.
  assert.deepEqual(split("2026-11-23T15:00:00Z","2026-11-23T18:00:00Z"),
    {total:180,day:0,night:180});
  // 05:00->09:00 local = 1h night + 3h day.
  assert.deepEqual(split("2026-11-22T21:00:00Z","2026-11-23T01:00:00Z"),
    {total:240,day:180,night:60});
  // 14:15->17:15 local = 3h day.
  assert.deepEqual(split("2026-11-20T06:15:00Z","2026-11-20T09:15:00Z"),
    {total:180,day:180,night:0});
  assert.equal(split("2026-11-20T06:15:00Z","2026-11-20T09:15:00Z").day+
    split("2026-11-20T06:15:00Z","2026-11-20T09:15:00Z").night,180);
});

test("unfinished and auto-missing-out records yield no payable day/night hours",()=>{
  const base={status:"auto_missing_out",check_in_at:"2026-11-23T08:00:00Z",
    check_out_at:"2026-11-23T17:00:00Z"};
  assert.equal(scriptFns.dayNightMinutes_(base),null);
  assert.equal(scriptFns.dayNightMinutes_({...base,status:"open",check_out_at:null}),null);
});

test("never allow spreadsheet formula injection from staff names",()=>{
  assert.equal(scriptFns.safeSheetText_("=HYPERLINK(...)"),"'=HYPERLINK(...)");
  assert.equal(scriptFns.safeSheetText_("+123"),"'+123");
  assert.equal(scriptFns.safeSheetText_("Номинзул"),"Номинзул");
});

test("server enforces the approved branch Wi-Fi IP, not browser-supplied coordinates",()=>{
  const wiFiSQL=readFileSync("database/portal_v2_attendance_wifi.sql","utf8");
  assert.match(wiFiSQL,/112\.72\.7\.161/);
  assert.match(wiFiSQL,/Нарны Титэм/);
  assert.match(wiFiSQL,/portal_v2_attendance_clock_wifi/);
  assert.match(wiFiSQL,/revoke all on public\.portal_v2_attendance_allowed_ips/);
  assert.match(wiFiSQL,/revoke all on function public\.portal_v2_attendance_clock_wifi/);
  assert.match(edge,/request\.headers\.get\("cf-connecting-ip"\)/);
  assert.match(edge,/attendanceWiFi\(user,req\.headers\["trusted-cf-connecting-ip"\]\)/);
  assert.match(edge,/ensure\(network\.connected,403/);
  assert.match(edge,/portal_v2_attendance_clock_wifi/);
  assert.match(edge,/const user = await current\(req\)/);
  assert.ok(!inline.includes("navigator.geolocation.getCurrentPosition"));
  assert.ok(!inline.includes('api("attendanceClock",{type,...position})'));
  assert.match(inline,/!data\.onAllowedWiFi/);
  assert.match(inline,/Явсан дараагүй/);
});

test("approved Wi-Fi accepts exact IP, denies other IP, and fails closed when not configured",async()=>{
  const start=edge.indexOf("function isIPv4(value) {");
  const end=edge.indexOf("async function attendanceStatus(",start);
  assert.ok(start>=0&&end>start);
  const make=rows=>new Function("db","q",edge.slice(start,end)+
    "\nreturn {attendanceWiFi};")(async()=>rows,encodeURIComponent);
  const user={employee_code:"123204",branch_code:"Нарны Титэм",access_role:"employee"};
  const manager={...user,access_role:"manager"};
  const stored=[{branch_code:"Нарны Титэм",allowed_ipv4:"112.72.7.161/32"}];
  const api=make(stored);
  assert.deepEqual(await api.attendanceWiFi(user,"112.72.7.161"),
    {configured:true,connected:true,displayIP:null});
  assert.deepEqual(await api.attendanceWiFi(manager,"112.72.7.161"),
    {configured:true,connected:true,displayIP:"112.72.7.161"});
  assert.equal((await api.attendanceWiFi(user,"112.72.7.162")).connected,false);
  assert.equal((await api.attendanceWiFi(user,"112.72.7.161, 1.2.3.4")).connected,false);
  assert.equal((await api.attendanceWiFi(user,"")).connected,false);
  assert.equal((await make([]).attendanceWiFi(user,"112.72.7.161")).configured,false);
});

test("private Sheets export requires server configured long-lived secret",()=>{
  assert.match(edge,/GOOGLE_SHEETS_SYNC_TOKEN/);
  assert.match(edge,/await requireAttendanceExport\(req\)/);
  assert.match(sql,/revoke all on public\.portal_v2_attendance_sites/);
  assert.ok(!appScript.includes("SUPABASE_SERVICE_ROLE_KEY"));
  assert.match(appScript,/getProperty\("ATTENDANCE_SYNC_TOKEN"\)/);
  assert.match(appScript,/ScriptApp\.newTrigger\("synchronizeAttendance"\)/);
});

test("employee clock buttons require connected approved Wi-Fi",()=>{
  assert.match(inline,/!data\.configured\|\|!data\.onAllowedWiFi\|\|!!open/);
  assert.match(inline,/!data\.configured\|\|!data\.onAllowedWiFi\|\|!open/);
  assert.match(inline,/Мобайл дата\/VPN/);
});

test("reject invalid or proxy-supplied IP fallback",()=>{
  const start=edge.indexOf("function isIPv4(value) {");
  const end=edge.indexOf("async function attendanceWiFi(",start);
  assert.ok(start>=0&&end>start);
  const {isIPv4}=new Function(edge.slice(start,end)+";return {isIPv4};")();
  assert.ok(isIPv4("112.72.7.161"));
  for(const ip of ["","112.72.7.161, 10.0.0.1","112.72.7.161/32","112.72.7.999",
    "0112.72.7.161","::1",null,"10.0.0.1"]) {
    if(ip==="10.0.0.1")continue; // valid IPv4, just not allowlisted
    assert.equal(isIPv4(ip),false,"Must reject malformed client IP");
  }
  const attendanceBlock=edge.slice(edge.indexOf("async function attendanceWiFi("),
    edge.indexOf("async function attendanceStatus("));
  assert.ok(!attendanceBlock.includes("x-forwarded-for"));
});

