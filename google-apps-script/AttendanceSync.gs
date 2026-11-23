/**
 * GS25 attendance -> native Google Sheets.
 * Install this into Extensions > Apps Script of "ИРц бүртгэл".
 *
 * Required Script property: ATTENDANCE_SYNC_TOKEN
 * Required Supabase Edge Function secret: GOOGLE_SHEETS_SYNC_TOKEN
 * Both MUST contain the same long random value (at least 32 characters).
 *
 * NEVER paste any token in this source file or in a shared spreadsheet cell.
 * The token gives read-only access to attendance export; keep the script private.
 */
const GS25_ATTENDANCE = Object.freeze({
  spreadsheetId: "1Q_fKf_MUcmmgKVvOyTZx9R5cDi3xy4kiA1tJNaHfoJI",
  endpoint: "https://zxhbufwncnijmpwzokvt.supabase.co/functions/v1/portal",
  timezone: "Asia/Ulaanbaatar",
  pageSize: 300
});

/** Run once manually after setting both secrets. */
function installAttendanceSync() {
  const value=PropertiesService.getScriptProperties().getProperty("ATTENDANCE_SYNC_TOKEN");
  if(!value||value.length<32) throw new Error("Set ATTENDANCE_SYNC_TOKEN in Apps Script properties first.");
  const triggers=ScriptApp.getProjectTriggers();
  for(const trigger of triggers) {
    if(trigger.getHandlerFunction()==="synchronizeAttendance") ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger("synchronizeAttendance").timeBased().everyMinutes(5).create();
  synchronizeAttendance();
}

function synchronizeAttendance() {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000)) return;
  try {
    const token=PropertiesService.getScriptProperties().getProperty("ATTENDANCE_SYNC_TOKEN");
    if(!token||token.length<32) throw new Error("Missing ATTENDANCE_SYNC_TOKEN Script property.");
    const all=fetchAttendanceRecords_(token);
    const spreadsheet=SpreadsheetApp.openById(GS25_ATTENDANCE.spreadsheetId);
    const tabs=employeeSheets_(spreadsheet);
    for(const entry of all){
      const code=String(entry.employee_code);
      if(!/^[0-9]{4,12}$/.test(code)) continue;
      let tab=tabs[code];
      if(!tab){
        tab=createEmployeeSheet_(spreadsheet,code,String(entry.display_name||code));
        tabs[code]=tab;
      }
    }
    syncEmployeeSheets_(all,tabs);
    syncInfo_(spreadsheet,all);
    SpreadsheetApp.flush();
  } finally {lock.releaseLock();}
}

function fetchAttendanceRecords_(token) {
  const all=[];
  for(let offset=0;offset<=1000000;offset+=GS25_ATTENDANCE.pageSize) {
    const uri=GS25_ATTENDANCE.endpoint+"?action=attendanceExport&offset="+offset;
    const response=UrlFetchApp.fetch(uri,{
      method:"get",muteHttpExceptions:true,
      headers:{"x-attendance-sync":token}
    });
    if(response.getResponseCode()!==200) {
      throw new Error("Attendance export HTTP "+response.getResponseCode()+": "+
        response.getContentText().slice(0,180));
    }
    const result=JSON.parse(response.getContentText());
    if(!Array.isArray(result.rows))throw new Error("Invalid attendance export response.");
    all.push(...result.rows);
    if(result.nextOffset===null || result.nextOffset===undefined) return all;
    if(result.nextOffset!==offset+GS25_ATTENDANCE.pageSize)throw new Error("Unexpected export page order");
  }
  throw new Error("Too many attendance rows for one sync run.");
}

function employeeSheets_(spreadsheet) {
  const result={};
  for(const tab of spreadsheet.getSheets()){
    if(tab.getName()==="Info")continue;
    const marker=String(tab.getRange("A1").getDisplayValue()).trim();
    const match=/^GS25_ID=([0-9]{4,12})$/.exec(marker);
    if(match)result[match[1]]=tab;
  }
  return result;
}

function cleanSheetName_(name,code){
  const cleaned=name.replace(/[\\/:?*[\]]/g," ").trim().slice(0,75);
  return cleaned||"Ажилтан "+code;
}

function createEmployeeSheet_(book,code,displayName){
  const base=cleanSheetName_(displayName,code);
  const title=book.getSheetByName(base)?(base+" ("+code+")"):base;
  const tab=book.insertSheet(title);
  tab.getRange("A1").setValue("GS25_ID="+code);
  tab.getRange("A2:F2").setValues([[
    "Өдөр","Ирсэн цаг","Явсан цаг","Нийт ажилласан цаг","Тайлбар","Portal record ID"
  ]]);
  tab.getRange("A2:F2").setBackground("#244d99").setFontColor("#ffffff").setFontWeight("bold");
  tab.setFrozenRows(2);
  tab.setColumnWidths(1,5,155);
  tab.hideColumns(6);
  return tab;
}

function timeInUlaanbaatar_(timestamp) {
  return timestamp?Utilities.formatDate(
    new Date(timestamp),GS25_ATTENDANCE.timezone,"HH:mm"):"";
}

function duration_(record) {
  if(record.status!=="completed"||!record.check_out_at)return "-";
  const minutes=Math.round((Date.parse(record.check_out_at)-Date.parse(record.check_in_at))/60000);
  if(!Number.isFinite(minutes)||minutes<0)return "-";
  return Math.floor(minutes/60)+":"+String(minutes%60).padStart(2,"0");
}

function rowFromAttendance_(record){
  const status={
    open:"Яваагүй",
    completed:"Хэвийн",
    auto_missing_out:"Явсан дараагүй"
  }[record.status]||"Шалгах";
  return [
    String(record.work_date).replace(/-/g,"/"),
    timeInUlaanbaatar_(record.check_in_at),
    timeInUlaanbaatar_(record.check_out_at)||"",
    duration_(record),
    status,
    String(record.id)
  ];
}

function syncEmployeeSheets_(records,tabs){
  const grouped={};
  for(const record of records){
    const code=String(record.employee_code);
    (grouped[code]||(grouped[code]=[])).push(record);
  }
  for(const [code,tab] of Object.entries(tabs)){
    const items=(grouped[code]||[]).sort((a,b)=>String(a.check_in_at).localeCompare(String(b.check_in_at)));
    if(!items.length)continue;
    const last=Math.max(2,tab.getLastRow());
    const existing=last>=3?tab.getRange(3,6,last-2,1).getDisplayValues().flat():[];
    const byId=new Map();
    existing.forEach((id,i)=>{if(id)byId.set(String(id),i+3);});
    const newRows=[];
    for(const record of items){
      const row=rowFromAttendance_(record);
      const id=String(record.id);
      if(byId.has(id)){
        const rowIdx=byId.get(id);
        const current=tab.getRange(rowIdx,1,1,6).getDisplayValues()[0];
        if(current.some((value,i)=>String(value)!==String(row[i]))) {
          tab.getRange(rowIdx,1,1,6).setValues([row]);
        }
        markAttendanceStatus_(tab,rowIdx,record.status);
      }else{
        newRows.push({row,record});
      }
    }
    if(newRows.length){
      const index=Math.max(3,tab.getLastRow()+1);
      if(tab.getMaxRows()<index+newRows.length-1)
        tab.insertRowsAfter(tab.getMaxRows(),index+newRows.length-1-tab.getMaxRows());
      tab.getRange(index,1,newRows.length,6).setValues(newRows.map(v=>v.row));
      for(let i=0;i<newRows.length;i++) markAttendanceStatus_(tab,index+i,newRows[i].record.status);
    }
  }
}

function markAttendanceStatus_(tab,row,status){
  const colour=status==="completed"?"#b6d7a8":status==="auto_missing_out"?"#ea9999":"#fff2cc";
  tab.getRange(row,5).setBackground(colour);
}

function payrollCycle_(date){
  const [year,month,day]=date.split("-").map(Number);
  const period=new Date(Date.UTC(year,month-1+(day>=26?1:0),1));
  const endYear=period.getUTCFullYear(),endMonth=period.getUTCMonth()+1;
  const ym=endYear+"-"+String(endMonth).padStart(2,"0");
  const from=new Date(Date.UTC(endYear,endMonth-2,26));
  const first=Utilities.formatDate(from,"UTC","yyyy-MM-dd");
  return {ym,from:first,to:ym+"-25"};
}

function syncInfo_(book,records){
  let info=book.getSheetByName("Info");
  if(!info){
    info=book.insertSheet("Info");
    info.getRange("A2:J2").setValues([[
      "Цалингийн сар","Мөчлөг эхлэх","Мөчлөг дуусах","Ажилтны код","Ажилтны нэр","Салбар",
      "Хэвийн ирц (хоног)","Ажилласан цаг","Явсан дараагүй","Нээлттэй"
    ]]);
    info.setFrozenRows(2);
  }
  const groups=new Map();
  for(const rec of records){
    const period=payrollCycle_(String(rec.work_date));
    const key=period.ym+"|"+rec.employee_code;
    if(!groups.has(key))groups.set(key,{
      ym:period.ym,from:period.from,to:period.to,
      code:String(rec.employee_code),name:String(rec.display_name),
      branch:String(rec.branch_code),completed:0,minutes:0,missing:0,open:0
    });
    const row=groups.get(key);
    if(rec.status==="completed"){
      const duration=Math.round((Date.parse(rec.check_out_at)-Date.parse(rec.check_in_at))/60000);
      if(Number.isFinite(duration)&&duration>=0){
        row.completed++;row.minutes+=duration;
      }
    }else if(rec.status==="auto_missing_out")row.missing++;
    else if(rec.status==="open")row.open++;
  }
  const rows=[...groups.values()].sort((a,b)=>
    b.ym.localeCompare(a.ym)||a.code.localeCompare(b.code)).map(x=>[
    x.ym,x.from,x.to,x.code,x.name,x.branch,x.completed,
    Math.floor(x.minutes/60)+":"+String(x.minutes%60).padStart(2,"0"),x.missing,x.open
  ]);
  // Info is an auto-generated tab. Preserve headers and only replace its summary rows.
  const oldLast=info.getLastRow();
  if(oldLast>2) info.getRange(3,1,oldLast-2,10).clearContent();
  if(rows.length){
    if(info.getMaxRows()<rows.length+2)
      info.insertRowsAfter(info.getMaxRows(),rows.length+2-info.getMaxRows());
    info.getRange(3,1,rows.length,10).setValues(rows);
  }
}
