/* ─── Supabase client ─── */
const SUPABASE_URL='https://qvdiusgdfncppgvrjbmd.supabase.co';
const SUPABASE_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF2ZGl1c2dkZm5jcHBndnJqYm1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNjE4MDksImV4cCI6MjA5MzgzNzgwOX0.WDPuRAka7XUAtu0bkGpBefmNM4Ngfr6oHlMg35K7JRQ';
const sb=supabase.createClient(SUPABASE_URL,SUPABASE_KEY);
/* ─── Supabase migration needed ───
   Run this in Supabase SQL Editor to support multi-jobsite supervisors:

   ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS jobsites text[] DEFAULT '{}';
   UPDATE supervisors SET jobsites = ARRAY[jobsite] WHERE jobsites = '{}' AND jobsite IS NOT NULL;

   ─────────────────────────────────────────────────────────────────────── */


/* ─── Constants ─── */
let JOBSITES=[];
let ACTIVITIES=[];     // active only — shown to employees
let ALL_ACTIVITIES=[]; // all including inactive — shown in admin panel
const AUTO_H=12;
const MASTER_PASSWORD='master2024';

/* ─── In-memory state (loaded from DB on boot) ─── */
let JOBSITE_DATA={};  // name → {address, gc, jobNumber, corfixUrl}
let supervisors=[]; // derived at runtime from employees where dept='Supervisor'
let DEPARTMENTS=[]; // loaded from DB
let employees=[];
let APP_SETTINGS={  // pay rules — loaded from Supabase `pt_settings` row on boot (v36.1, lunch added v36.2)
  roundingEnabled:false, roundingMinutes:15,
  schedEndEnabled:false, schedEndTime:'15:30', schedEndWindow:15,
  lunchEnabled:false, lunchMinutes:30, lunchThresholdHours:5
};
let timeLog=[];      // active punches only cached in memory for speed
let currentPin='';
let pendingClockOut=null;
let lunchWaiveRequested=false; // v42.0 — employee's "worked through lunch" tick on the clock-out screen
let selectedActs=new Set();
let editingIdx=null; // index into timeLog array
let addingPunch=false;   // true while the shared edit modal is in manual-add mode (v37.0)
let addPunchCtx='master';// which log opened the add modal ('sup' | 'master' | 'subcorrect') so we refresh the right one
let editActs=new Set();
let editingSupId=null;
let editingEmpId=null;
let activeSup=null;
// v46.0: admin correction modal (tap a name in the Submissions panel to view/edit that
// employee's punches inline, no separate supervisor review needed).
let _adminCorrectEmpId=null;
let _adminCorrectEmpName=null;
let exportRange={from:null,to:null};
let empModalContext='master';
let ARCHIVED_JOBSITES=[];
/* My Timecard (employee self-edit, v41.0) */
let myTcEmp=null;
let myTcPeriod=null;
let myTcPunches=[];
let myTcLocked=false;
let myTcSiteStageMap={}; // v47.0: per-site stage map {jobsite: stage} for My Timecard
let myTcEditingDbId=null;
let myTcAdding=false;
let myTcEditActs=new Set();
/* v45.0: last-period catch-up. myTcPeriodOffset drives which period My Timecard is showing
   (0=current, 1=last). myTcCatchupNeeded/myTcCatchupPeriod are refreshed every time the CURRENT
   period loads (see refreshMyTcCatchupState) and drive both the PIN-entry prompt and the banner. */
let myTcPeriodOffset=0;
let myTcCatchupNeeded=false;
let myTcCatchupPeriod=null;
/* Timecard submission stage (v44.0) — pt_timecard_status table.
   Stage lifecycle: open → emp_submitted → sup_submitted → exported.
   Absence of a row = 'open'. */
const TC_STAGE={OPEN:'open',EMP:'emp_submitted',SUP:'sup_submitted',EXPORTED:'exported'};
// Rank for comparisons (e.g. "is this at/after sup_submitted?")
const TC_STAGE_RANK={open:0,emp_submitted:1,sup_submitted:2,exported:3};
let myTcStatusRows=[]; // v44.0 Build 3: ALL of this employee's status rows for the period (one
                       // per jobsite they worked — see pt_timecard_status schema note below).
                       // [] = open everywhere. Aggregate helpers: minStage()/maxStage().
let myTcBusy=false;    // guards the submit/retract buttons against double-taps
let myTcEditable=true; // v44.0: true only while no rows exist yet (never submitted). Once
                       // submitted, the employee must pull back before editing; once ANY site
                       // row reaches sup_submitted the whole card is hard-locked.

/* ─── Loading UI helpers ─── */
function setLoading(msg){
  const ov=document.getElementById('loading-overlay');
  if(ov){ov.style.display='flex';document.getElementById('loading-msg').textContent=msg||'Loading…';}
}
function hideLoading(){
  const ov=document.getElementById('loading-overlay');
  if(ov)ov.style.display='none';
}
function showDbError(msg){
  hideLoading();
  showCustomAlert('Database error',msg+' — check your connection and refresh.');
}

/* ─── Theme ─── */
function applyTheme(t){
  const app=document.getElementById('app');
  app.removeAttribute('data-theme');
  if(t==='light'||t==='dark'||t==='auto') app.setAttribute('data-theme',t);
  ['light','dark','auto'].forEach(m=>{
    const btn=document.getElementById('theme-btn-'+m);
    if(btn) btn.classList.toggle('active',m===t);
  });
}
function setTheme(t){
  localStorage.setItem('pt-theme',t);
  applyTheme(t);
}

/* ─── Date/time helpers ─── */
function fmt(d){return d instanceof Date?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'—'}
// Full: "Tue, May 6 · 08:30 AM"
function fmtFull(d){
  if(!(d instanceof Date))return '—';
  const day=d.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'});
  return `${day} · ${fmt(d)}`;
}
// Compact: "Tue May 6, 8:30 AM"
function fmtDt(d){
  if(!(d instanceof Date))return '—';
  return d.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})+', '+fmt(d);
}
function fmtDate(d){return d instanceof Date?d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'}):'—'}
function toLocal(d){if(!(d instanceof Date))return '';const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`}
function toDateStr(d){if(!(d instanceof Date))return '';const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`}

/* ─── Pay-rule engine (v36.1) ──────────────────────────────────────────────
   Settings live in Supabase (`pt_settings` row, id=1) so every device agrees.
   Both rules are DISPLAY/EXPORT-ONLY — raw punches in the DB are never changed.
   Order is credit-then-round. Auto-clocked & estimated punches are left exact. */
function applySettingsRow(r){
  APP_SETTINGS={
    roundingEnabled:!!r.rounding_enabled,
    roundingMinutes:r.rounding_minutes||15,
    schedEndEnabled:!!r.sched_end_enabled,
    schedEndTime:r.sched_end_time||'15:30',
    schedEndWindow:(r.sched_end_window!=null?r.sched_end_window:15),
    lunchEnabled:!!r.lunch_enabled,
    lunchMinutes:(r.lunch_minutes!=null?r.lunch_minutes:30),
    lunchThresholdHours:(r.lunch_threshold_hours!=null?r.lunch_threshold_hours:5)
  };
}
// Round a Date to the nearest interval using local clock minutes (7/8 breakpoint
// for 15-min; same nearest-rule for 6/5). Timezone-safe — works on local time-of-day.
function roundTime(d,intervalMin){
  if(!intervalMin||intervalMin<1)return d;
  const r=new Date(d);
  const total=r.getHours()*60+r.getMinutes()+r.getSeconds()/60;
  const rounded=Math.round(total/intervalMin)*intervalMin;
  r.setHours(0,rounded,0,0); // setHours normalizes minute overflow into hours/day
  return r;
}
// Credit a clock-out up to the scheduled end if it falls inside the window before it.
// Never clips a later punch-out (real overtime is paid). No credit for genuine early leaves.
function applySchedEnd(inT,outT){
  const [eh,em]=(APP_SETTINGS.schedEndTime||'15:30').split(':').map(Number);
  const sched=new Date(outT);sched.setHours(eh,em,0,0);
  const winStart=new Date(sched.getTime()-(APP_SETTINGS.schedEndWindow||15)*60000);
  if(outT>=winStart&&outT<sched)return sched;
  return outT;
}
// Effective {in,out} after applying enabled rules. Synthetic punches untouched.
function adjustedTimes(entry){
  let inT=entry.in,outT=entry.out;
  if(!outT)return {in:inT,out:null};
  if(entry.autoClocked||entry.estimatedOut)return {in:inT,out:outT};
  if(APP_SETTINGS.schedEndEnabled)outT=applySchedEnd(inT,outT);
  if(APP_SETTINGS.roundingEnabled){inT=roundTime(inT,APP_SETTINGS.roundingMinutes);outT=roundTime(outT,APP_SETTINGS.roundingMinutes);}
  return {in:inT,out:outT};
}
// Paid hours for a punch (null if still open). Used everywhere hours are totalled.
function paidHours(entry){
  if(!entry.out)return null;
  const a=adjustedTimes(entry);
  let hrs=Math.max(0,(a.out-a.in)/3600000);
  // Unpaid lunch deduction (v36.2) — final step, after credit+round.
  // Skips synthetic punches (auto-clocked / estimated) like the other rules.
  // Display/export-only; raw punch is never modified. Threshold is checked
  // against the adjusted elapsed hours so it reflects what's actually paid.
  if(APP_SETTINGS.lunchEnabled && !entry.autoClocked && !entry.estimatedOut
     && hrs>APP_SETTINGS.lunchThresholdHours
     && entry.lunchWaived!==true){
    hrs=Math.max(0,hrs-(APP_SETTINGS.lunchMinutes||0)/60);
  }
  return hrs;
}

// Pending lunch-waive (v42.0): employee asked, supervisor hasn't decided yet.
// Used by the needs-review filter, the Needs Review tile, and the export gate.
function isPendingWaive(entry){
  return !!entry && entry.lunchWaiveRequested===true && entry.lunchWaived==null;
}

/* ─── Timecard submission stage — data layer (v44.0) ───
   Table: pt_timecard_status. One row per employee per pay period.
   No row = 'open'. Stage: open → emp_submitted → sup_submitted → exported.
   These helpers are the single source of truth for the whole submission flow.

   v44.0 Build 3 schema change: the table moved from ONE ROW PER EMPLOYEE PER PERIOD to
   ONE ROW PER EMPLOYEE PER PERIOD PER JOBSITE (unique key employee_id+period_start+jobsite).
   Reason: employees can split a pay period across multiple jobsites/supervisors, and each
   site needs its own independent submit/export lifecycle. jobsite is now REQUIRED on every
   write — never call setTimecardStage() without one. */

// Fetch one employee's status row for a given period start + jobsite. null = open (no row yet).
async function getTimecardStatus(empId,periodStart,jobsite){
  const ps=toDateStr(periodStart);
  const {data,error}=await sb.from('pt_timecard_status')
    .select('*').eq('employee_id',empId).eq('period_start',ps).eq('jobsite',jobsite).maybeSingle();
  if(error){console.warn('getTimecardStatus error:',error.message);return null;}
  return data||null;
}

// Fetch ALL of one employee's status rows for a period (every jobsite they've submitted at).
// Used by My Timecard, which shows one aggregate view regardless of how many sites they worked.
async function getEmployeeStatusRows(empId,periodStart){
  const ps=toDateStr(periodStart);
  const {data,error}=await sb.from('pt_timecard_status')
    .select('*').eq('employee_id',empId).eq('period_start',ps);
  if(error){console.warn('getEmployeeStatusRows error:',error.message);return [];}
  return data||[];
}

// Fetch ALL status rows for a period, returned as a map keyed by employee_id → array of rows
// (one entry per jobsite that employee has a row for). Used by the supervisor log and the
// admin submissions panel.
async function getAllStatusForPeriod(periodStart){
  const ps=toDateStr(periodStart);
  const {data,error}=await sb.from('pt_timecard_status').select('*').eq('period_start',ps);
  if(error){console.warn('getAllStatusForPeriod error:',error.message);return {};}
  const map={};
  (data||[]).forEach(r=>{(map[r.employee_id]=map[r.employee_id]||[]).push(r);});
  return map;
}

// Move an employee's timecard to a new stage for a period+jobsite (upsert on
// employee_id+period_start+jobsite). Stamps the matching timestamp column.
// jobsite is REQUIRED (it's part of the row's identity now). Returns {ok, error}.
async function setTimecardStage(empId,period,stage,jobsite){
  if(jobsite==null){console.warn('setTimecardStage called without a jobsite');return {ok:false,error:{message:'jobsite is required'}};}
  const ps=toDateStr(period.start),pe=toDateStr(period.end);
  const nowIso=new Date().toISOString();
  const row={
    employee_id:empId,period_start:ps,period_end:pe,jobsite,
    stage,updated_at:nowIso
  };
  if(stage===TC_STAGE.EMP)row.emp_submitted_at=nowIso;
  else if(stage===TC_STAGE.SUP)row.sup_submitted_at=nowIso;
  else if(stage===TC_STAGE.EXPORTED)row.exported_at=nowIso;
  const {error}=await sb.from('pt_timecard_status')
    .upsert(row,{onConflict:'employee_id,period_start,jobsite'});
  if(error){console.warn('setTimecardStage error:',error.message);return {ok:false,error};}
  return {ok:true};
}

// v47.4: which pay period does a given date fall in? Walks a handful of offsets
// (current + several past). Used by the orphan-row cleanup below to target the
// OLD punch's period even when an edit moved its date. Falls back to current.
function periodContaining(date){
  if(!(date instanceof Date)||isNaN(date))return getPeriodByOffset(0);
  for(let off=0;off<=6;off++){
    const p=getPeriodByOffset(off);
    if(date>=p.start&&date<=p.end)return p;
  }
  return getPeriodByOffset(0);
}

// v47.4: data hygiene. When a punch's jobsite is edited away (or a punch is deleted)
// such that the employee no longer has ANY punch at (jobsite) in (period), the
// pt_timecard_status row for that now-unworked site is orphaned. Left in place it
// poisons every consumer that derives "sites worked" from status rows instead of
// punches — the My Timecard submit bar (phantom "Submit" site), the supervisor chip
// (minStage dragged down → "Not submitted" beside a live "Send to office"), and
// isFullyReadyForExport (a stray 'open' row blocks export forever). This deletes the
// orphan at the source so all three self-correct with no changes to them.
// SAFETY: only 'open'/'emp_submitted' rows are removed — a row a supervisor or the
// office has already acted on (sup_submitted/exported) is never touched.
async function cleanupOrphanStatusRow(empId,jobsite,period){
  if(empId==null||jobsite==null||!period)return;
  // Still worked here? A single surviving punch keeps the row.
  const {data:remain,error:remErr}=await sb.from('punches').select('id')
    .eq('employee_id',empId).eq('jobsite',jobsite)
    .gte('clock_in',period.start.toISOString())
    .lte('clock_in',period.end.toISOString()).limit(1);
  if(remErr){console.warn('cleanupOrphanStatusRow punch-check error:',remErr.message);return;}
  if(remain&&remain.length)return; // still worked at this site — keep the row
  // Fetch the status row; no row = nothing to clean (already open-by-absence).
  const row=await getTimecardStatus(empId,period.start,jobsite);
  if(!row)return;
  if(row.stage!==TC_STAGE.OPEN&&row.stage!==TC_STAGE.EMP)return; // never touch sup_submitted/exported
  const {error:delErr}=await sb.from('pt_timecard_status').delete()
    .eq('employee_id',empId).eq('period_start',toDateStr(period.start)).eq('jobsite',jobsite);
  if(delErr)console.warn('cleanupOrphanStatusRow delete error:',delErr.message);
}

// Convenience: which stage is this status row at? (null row = open)
function stageOf(statusRow){return statusRow?statusRow.stage:TC_STAGE.OPEN;}
// Is a stage at or past a target? e.g. stageAtLeast(row, TC_STAGE.SUP)
function stageAtLeast(stage,target){return (TC_STAGE_RANK[stage]||0)>=(TC_STAGE_RANK[target]||0);}
// Aggregate helpers across an employee's multiple site-rows (v44.0 Build 3):
//  - minStage: the LEAST advanced stage — "what still needs attention" (used by the
//    supervisor card & admin readiness checks).
//  - maxStage: the MOST advanced stage — used for My Timecard's hard-lock (once ANY site has
//    gone to the office, the whole card locks; partial per-site employee editing is out of scope).
function minStage(rows){
  if(!rows||!rows.length)return TC_STAGE.OPEN;
  return rows.reduce((m,r)=>TC_STAGE_RANK[r.stage]<TC_STAGE_RANK[m]?r.stage:m,rows[0].stage);
}
function maxStage(rows){
  if(!rows||!rows.length)return TC_STAGE.OPEN;
  return rows.reduce((m,r)=>TC_STAGE_RANK[r.stage]>TC_STAGE_RANK[m]?r.stage:m,rows[0].stage);
}
// Is this employee fully ready to export? True only if EVERY jobsite they worked this period
// (sitesWorked — pass the jobsites from their PUNCHES, not just their existing status rows) has
// a row at exactly sup_submitted. A jobsite with no row at all still blocks readiness — it's
// implicitly 'open' there, not something isFullyReadyForExport should skip past. Under this
// design export is all-or-nothing per employee (fires once across every site, stamping all rows
// exported together), so a mix of exported + non-exported rows shouldn't occur in practice.
function isFullyReadyForExport(rows,sitesWorked){
  const sites=new Set([...(sitesWorked||[]),...(rows||[]).map(r=>r.jobsite)]);
  if(!sites.size)return false;
  return [...sites].every(s=>{const r=(rows||[]).find(rr=>rr.jobsite===s);return !!r&&r.stage===TC_STAGE.SUP;});
}

// v47.5: shared by the overview "Ready to Export" tile so it can check an arbitrary period
// (current AND last) without duplicating the status/punch query + isFullyReadyForExport filter.
async function computeReadyCountForPeriod(period){
  const [statusMap,punchRes]=await Promise.all([
    getAllStatusForPeriod(period.start),
    sb.from('punches').select('employee_id,jobsite')
      .gte('clock_in',period.start.toISOString())
      .lte('clock_in',period.end.toISOString())
  ]);
  if(punchRes.error)return 0;
  const sitesWorkedByEmp={};
  (punchRes.data||[]).forEach(p=>{
    if(!p.employee_id)return;
    (sitesWorkedByEmp[p.employee_id]=sitesWorkedByEmp[p.employee_id]||new Set()).add(p.jobsite);
  });
  return Object.keys(statusMap).filter(id=>isFullyReadyForExport(statusMap[id],[...(sitesWorkedByEmp[id]||[])])).length;
}

// Out-of-submission punch (v44.0): a punch whose clock-in is newer than the employee's
// emp_submitted_at, while the timecard is at emp_submitted or later. Flags the supervisor
// that the employee worked after handing in their card (no re-submit required).
function isOutOfSubmission(entry,statusRow){
  if(!statusRow||!statusRow.emp_submitted_at)return false;
  if(!stageAtLeast(statusRow.stage,TC_STAGE.EMP))return false;
  return entry.in>new Date(statusRow.emp_submitted_at);
}

// Running-total paid hours for the My Timecard panel (v44.0).
//  - Excludes still-active punches (no clock-out yet) — same as paidHours returning null.
//  - Optimistically treats a PENDING lunch waive as if approved, so the running total
//    reflects what the employee expects (with an on-screen disclaimer). A supervisor
//    denial would later reduce it. Approved/denied waives already flow through paidHours.
// Returns {hours, pendingWaiveCount}.
function myTcRunningHours(punches){
  let total=0,pendingWaives=0;
  (punches||[]).forEach(e=>{
    if(!e.out)return; // skip active punches
    if(isPendingWaive(e)){
      pendingWaives++;
      // Compute as if the waive were approved: temporarily flip the flag for the calc.
      const orig=e.lunchWaived;
      e.lunchWaived=true;
      const ph=paidHours(e);
      e.lunchWaived=orig; // restore — never mutate the real record
      if(ph!=null)total+=ph;
    } else {
      const ph=paidHours(e);
      if(ph!=null)total+=ph;
    }
  });
  return {hours:total,pendingWaiveCount:pendingWaives};
}

function updateClock(){
  const now=new Date();
  const el=document.getElementById('kiosk-time');const de=document.getElementById('kiosk-date');
  if(el)el.textContent=fmt(now);
  if(de)de.textContent=fmtDate(now);
}
// Clock started after bootApp loads
function startClock(){setInterval(updateClock,1000);updateClock();}

/* ─── Auto clock-out (server-side) ─── */
// checkAutoServer() is defined in the boot section above
setInterval(()=>checkAutoServer(),30000);

/* ─── Boot: load all data from Supabase ─── */
async function bootApp(){
  applyTheme(localStorage.getItem('pt-theme')||'dark');
  setLoading('Connecting to database…');
  try {
    // Load jobsites
    setLoading('Loading jobsites…');
    const {data:jsData,error:jsErr}=await sb.from('jobsites').select('*').eq('archived',false).order('name');
    if(jsErr)throw jsErr;
    JOBSITES=jsData.map(r=>r.name);
    JOBSITE_DATA={};
    jsData.forEach(r=>{JOBSITE_DATA[r.name]={address:r.address||'',gc:r.gc||'',jobNumber:r.job_number||'',corfixUrl:r.corfix_url||''};});

    // Load archived jobsites
    const {data:archData}=await sb.from('jobsites').select('*').eq('archived',true).order('name');
    ARCHIVED_JOBSITES=(archData||[]).map(r=>({name:r.name,archivedAt:new Date(r.archived_at||r.created_at),punchCount:0}));

    // Load departments
    setLoading('Loading departments…');
    const {data:deptData,error:deptErr}=await sb.from('departments').select('*').order('sort_order').order('name');
    if(deptErr)throw deptErr;
    DEPARTMENTS=deptData.map(r=>({id:r.id,name:r.name,protected:r.protected,active:r.active,sortOrder:r.sort_order}));

    // Load employees (includes supervisor_password and supervisor_jobsites)
    setLoading('Loading employees…');
    const {data:empData,error:empErr}=await sb.from('employees').select('*').order('name');
    if(empErr)throw empErr;
    employees=empData.map(r=>({
      id:r.id,name:r.name,pin:r.pin,dept:r.department,active:r.active,
      supervisorPassword:r.supervisor_password||null,
      supervisorJobsites:Array.isArray(r.supervisor_jobsites)?r.supervisor_jobsites:[]
    }));
    // Derive supervisors array from employees where dept='Supervisor'
    supervisors=employees.filter(e=>e.dept==='Supervisor'&&e.active).map(e=>({
      id:e.id,name:e.name,password:e.supervisorPassword,
      jobsites:e.supervisorJobsites
    }));

    // Load activities from DB
    setLoading('Loading activities…');
    const {data:actData,error:actErr}=await sb.from('activities').select('*').order('sort_order').order('name');
    if(actErr)throw actErr;
    ALL_ACTIVITIES=actData.map(r=>({id:r.id,name:r.name,code:r.code||'',sortOrder:r.sort_order,active:r.active}));
    ACTIVITIES=ALL_ACTIVITIES.filter(a=>a.active);

    // Load pay-rule settings (v36.1). Defaults stay in effect if the row is missing.
    setLoading('Loading settings…');
    try{
      const {data:setData}=await sb.from('pt_settings').select('*').eq('id',1).maybeSingle();
      if(setData)applySettingsRow(setData);
    }catch(setErr){ console.warn('Settings load failed, using defaults:',setErr); }

    // Load open punches (no clock-out) into memory for live status
    setLoading('Loading active punches…');
    const {data:punchData,error:punchErr}=await sb.from('punches').select('*').is('clock_out',null);
    if(punchErr)throw punchErr;
    timeLog=punchData.map(dbRowToEntry);

    // Check auto-clock any stale open punches
    await checkAutoServer();

    hideLoading();
    initDropdowns();
    rebuildDeptDropdown();
    startClock();
    tryRestoreSession();
  } catch(e){
    showDbError('Could not load data: '+e.message);
  }
}

/* ─── DB row → app entry ─── */
function dbRowToEntry(r){
  return {
    dbId:r.id,
    empId:r.employee_id,
    name:r.employee_name,
    dept:r.department,
    jobsite:r.jobsite,
    in:new Date(r.clock_in),
    out:r.clock_out?new Date(r.clock_out):null,
    activity:r.activities?r.activities:[],
    autoClocked:r.auto_clocked||false,
    editedAfterAuto:r.edited_after_auto||false,
    manualEntry:r.manual_entry||false,
    // Lunch waive (v42.0) — request = employee's ask at clock-out (bool);
    // waived = supervisor's decision (nullable: null pending / true approved / false denied).
    lunchWaiveRequested:r.lunch_waive_requested||false,
    lunchWaived:(r.lunch_waived===true||r.lunch_waived===false)?r.lunch_waived:null
  };
}

/* ─── Auto clock-out: check open punches server-side ─── */
async function checkAutoServer(){
  const now=new Date();
  const stale=timeLog.filter(e=>!e.out&&(now-e.in)/3600000>=AUTO_H);
  for(const e of stale){
    const autoOut=new Date(e.in.getTime()+AUTO_H*3600000);
    if(!e.dbId){
      // No DB row to reconcile against — mark locally so it stops re-triggering.
      e.out=autoOut;e.autoClocked=true;e.activity=['Auto-clocked'];
      continue;
    }
    // Guarded auto-clock (v37.1): only writes when the punch is STILL open in the DB
    // (`clock_out is null`). A device holding a stale "open" copy therefore can NEVER
    // overwrite a real clock-out that was already recorded on another device.
    const {data,error}=await sb.from('punches').update({
      clock_out:autoOut.toISOString(),
      activities:['Auto-clocked'],
      auto_clocked:true
    }).eq('id',e.dbId).is('clock_out',null).select();
    if(error){continue;} // transient — leave open and retry next cycle
    if(data&&data.length){
      // We genuinely auto-clocked an open punch.
      e.out=autoOut;e.autoClocked=true;e.activity=['Auto-clocked'];
    }else{
      // 0 rows updated → it was already clocked out elsewhere. Heal stale local state.
      const {data:fresh}=await sb.from('punches').select('clock_out,activities,auto_clocked').eq('id',e.dbId).maybeSingle();
      if(fresh&&fresh.clock_out){
        e.out=new Date(fresh.clock_out);
        if(Array.isArray(fresh.activities))e.activity=fresh.activities;
        e.autoClocked=!!fresh.auto_clocked;
      }else if(!fresh){
        // Row was deleted — drop the stale entry so it stops being tracked.
        const idx=timeLog.indexOf(e);
        if(idx>=0)timeLog.splice(idx,1);
      }
    }
  }
}

/* ─── Init dropdowns ─── */
function refreshAllJobsiteDropdowns(){
  // Kiosk
  const kj=document.getElementById('kiosk-jobsite');
  if(kj)kj.innerHTML='<option value="">— select jobsite —</option>'+JOBSITES.map(j=>`<option>${j}</option>`).join('')+'<option value="__other__">Other / Temporary site…</option>';
  // Edit punch modal
  const ej=document.getElementById('edit-jobsite');
  if(ej){const cur=ej.value;ej.innerHTML=JOBSITES.map(j=>`<option${j===cur?' selected':''}>${j}</option>`).join('');}
  // Supervisor modal now uses checkboxes — rebuilt in openSupModal()
  // Master report filter
  const ms=document.getElementById('m-filter-site');
  if(ms){const cur=ms.value;ms.innerHTML='<option value="">All jobsites</option>'+JOBSITES.map(j=>`<option${j===cur?' selected':''}>${j}</option>`).join('');}
}
function initDropdowns(){refreshAllJobsiteDropdowns();}

function onKioskJobsiteChange(){
  const val=document.getElementById('kiosk-jobsite').value;
  const isOther=val==='__other__';
  document.getElementById('kiosk-other-wrap').style.display=isOther?'block':'none';
  document.getElementById('kiosk-other-spacer').style.display=isOther?'none':'block';
  if(isOther)setTimeout(()=>document.getElementById('kiosk-other-name').focus(),80);
}

/* ─── Checkbox pill toggle helper ─── */
function toggleChkPill(label){
  const chk=label.querySelector('input[type=checkbox]');
  if(!chk)return;
  chk.checked=!chk.checked;
  label.classList.toggle('checked',chk.checked);
}

function refreshNewJobsiteSupChecks(){
  const grid=document.getElementById('new-jobsite-sup-checks');
  if(!grid)return;
  if(!supervisors.length){grid.innerHTML='<p style="font-size:12px;color:var(--txt3);">No supervisors added yet.</p>';return;}
  grid.innerHTML=supervisors.map(s=>`<label class="chk-pill" onclick="toggleChkPill(this)"><input type="checkbox" value="${s.id}" style="pointer-events:none;"/>${s.name}</label>`).join('');
}

/* ─── Jobsite panel ─── */
const SITE_COLORS_MAP=['#2d7a2d','#1D9E75','#854F0B','#c0392b','#6b3fa8','#0e7490','#b45309','#0369a1','#7c3aed','#be185d','#0f766e','#b91c1c'];
function getSiteColor(idx){return SITE_COLORS_MAP[idx%SITE_COLORS_MAP.length];}

/* ─── Custom confirm / alert helpers ─── */
let _confirmCallback=null;
function showCustomConfirm(title,body,sub,okLabel,okColor,onOk){
  document.getElementById('cc-title').textContent=title;
  document.getElementById('cc-body').textContent=body;
  const subEl=document.getElementById('cc-sub');
  subEl.textContent=sub||'';subEl.style.display=sub?'block':'none';
  const okBtn=document.getElementById('cc-ok-btn');
  okBtn.textContent=okLabel||'Confirm';
  okBtn.style.background=okColor||'var(--red)';
  _confirmCallback=onOk;
  document.getElementById('custom-confirm-bg').style.display='flex';
}
function closeCustomConfirm(){document.getElementById('custom-confirm-bg').style.display='none';_confirmCallback=null;}
function doCustomConfirm(){if(_confirmCallback)_confirmCallback();closeCustomConfirm();}
function showCustomAlert(title,body){
  document.getElementById('ca-title').textContent=title;
  document.getElementById('ca-body').textContent=body;
  document.getElementById('custom-alert-bg').style.display='flex';
}
function closeCustomAlert(){document.getElementById('custom-alert-bg').style.display='none';}

// Wire OK button
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('cc-ok-btn').addEventListener('click',doCustomConfirm);
});

/* ─── Archived jobsites ─── */
// ARCHIVED_JOBSITES declared at top

function refreshJobsitePanel(){
  document.getElementById('jobsite-count').textContent=`${JOBSITES.length} active`;
  document.getElementById('jobsite-add-err').textContent='';
  const list=document.getElementById('jobsite-list');
  if(!JOBSITES.length){
    list.innerHTML='<p style="color:var(--txt2);font-size:13px;text-align:center;padding:20px 0;">No active jobsites — add one below.</p>';
  } else {
    list.innerHTML=JOBSITES.map((site,i)=>{
      const color=getSiteColor(i);
      const activeNow=timeLog.filter(l=>l.jobsite===site&&!l.out).length;
      const totalPunches=timeLog.filter(l=>l.jobsite===site).length;
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:11px 14px;border:0.5px solid var(--bdr);border-radius:var(--radius);margin-bottom:8px;background:var(--bg2);">
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="width:12px;height:12px;border-radius:50%;background:${color};flex-shrink:0;"></span>
          <div>
            <p style="font-size:14px;font-weight:600;color:var(--txt);margin:0;">${site}</p>
            <p style="font-size:11px;color:var(--txt2);margin:2px 0 0;">${supervisors.filter(s=>(s.jobsites||[]).includes(site)).map(s=>s.name).join(', ')||'No supervisor assigned'} &nbsp;·&nbsp; ${activeNow} clocked in &nbsp;·&nbsp; ${totalPunches} total punches</p>
          </div>
        </div>
        <div style="display:flex;gap:6px;"><button class="btn-sm" onclick="openEditJobsiteModal('${site.replace(/'/g,"\'")}')">Edit</button><button class="btn-sm danger" onclick="confirmRemoveJobsite('${site.replace(/'/g,"\'")}')">Archive</button></div>
      </div>`;
    }).join('');
  }
  refreshArchivePanel();
}

function refreshArchivePanel(){
  const badge=document.getElementById('archive-count-badge');
  badge.textContent=ARCHIVED_JOBSITES.length?`(${ARCHIVED_JOBSITES.length})`:'';
  const list=document.getElementById('archive-list');
  if(!ARCHIVED_JOBSITES.length){
    list.innerHTML='<p style="color:var(--txt2);font-size:13px;text-align:center;padding:12px 0;">No archived jobsites.</p>';
    return;
  }
  list.innerHTML=ARCHIVED_JOBSITES.map((a,i)=>{
    const archivedDate=a.archivedAt.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'});
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:0.5px solid var(--bdr);border-radius:var(--radius);margin-bottom:7px;background:var(--bg3);opacity:0.9;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:16px;">🗄</span>
        <div>
          <p style="font-size:13px;font-weight:600;color:var(--txt);margin:0;">${a.name}</p>
          <p style="font-size:11px;color:var(--txt2);margin:2px 0 0;">Archived ${archivedDate} &nbsp;·&nbsp; ${a.punchCount} punch record${a.punchCount!==1?'s':''} preserved</p>
        </div>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn-sm" onclick="viewArchivedPunches('${a.name.replace(/'/g,"\'")}')">View data</button>
        <button class="btn-sm primary" onclick="restoreJobsite('${a.name.replace(/'/g,"\'")}')">Restore</button>
      </div>
    </div>`;
  }).join('');
}

function toggleArchivedPanel(){
  const panel=document.getElementById('archive-panel');
  const chev=document.getElementById('archive-chevron');
  const open=panel.style.display==='none';
  panel.style.display=open?'block':'none';
  chev.textContent=open?'▾':'▸';
  if(open)refreshArchivePanel();
}

async function addJobsite(){
  const inp=document.getElementById('new-jobsite-name');
  const err=document.getElementById('jobsite-add-err');
  const name=inp.value.trim();
  if(!name){err.textContent='Please enter a jobsite name.';return}
  if(name.length<2){err.textContent='Name must be at least 2 characters.';return}
  if(JOBSITES.find(j=>j.toLowerCase()===name.toLowerCase())){err.textContent='A jobsite with that name already exists.';return}
  if(ARCHIVED_JOBSITES.find(a=>a.name.toLowerCase()===name.toLowerCase())){err.textContent='This name exists in archives — use Restore instead.';return}
  const newJobNumber=document.getElementById('new-jobsite-jobnumber')?.value.trim()||'';
  const newGc=document.getElementById('new-jobsite-gc')?.value.trim()||'';
  const newAddress=document.getElementById('new-jobsite-address')?.value.trim()||'';
  const {data,error}=await sb.from('jobsites').insert({name,archived:false,job_number:newJobNumber||null,gc:newGc||null,address:newAddress||null}).select().single();
  if(error){err.textContent='DB error: '+error.message;return}
  JOBSITES.push(name);
  JOBSITE_DATA[name]={jobNumber:newJobNumber,gc:newGc,address:newAddress,corfixUrl:''};
  inp.value='';
  if(document.getElementById('new-jobsite-jobnumber'))document.getElementById('new-jobsite-jobnumber').value='';
  if(document.getElementById('new-jobsite-gc'))document.getElementById('new-jobsite-gc').value='';
  if(document.getElementById('new-jobsite-address'))document.getElementById('new-jobsite-address').value='';
  err.textContent='';
  // Assign selected supervisors to this new jobsite
  const checkedSupIds=Array.from(document.querySelectorAll('#new-jobsite-sup-checks input:checked')).map(c=>parseInt(c.value));
  for(const s of supervisors){
    if(checkedSupIds.includes(s.id)){
      const newSites=[...(s.jobsites||[]),name];
      await sb.from('employees').update({supervisor_jobsites:newSites}).eq('id',s.id);
      s.jobsites=newSites;
    }
  }
  refreshAllJobsiteDropdowns();refreshJobsitePanel();refreshMasterSups();refreshMasterOverview();
}

/* ─── Edit jobsite modal ─── */
let _editingJobsiteOldName=null;

function openEditJobsiteModal(site){
  _editingJobsiteOldName=site;
  document.getElementById('edit-jobsite-old').value=site;
  document.getElementById('edit-jobsite-new').value=site;
  document.getElementById('edit-jobsite-err').textContent='';
  // Build supervisor checkboxes
  const grid=document.getElementById('ej-sup-checks');
  grid.innerHTML=supervisors.map(s=>{
    const assigned=(s.jobsites||[]).includes(site);
    return `<label class="${assigned?'chk-pill checked':'chk-pill'}" onclick="toggleChkPill(this)"><input type="checkbox" value="${s.id}" ${assigned?'checked':''} style="pointer-events:none;"/>${s.name}</label>`;
  }).join('') || '<p style="font-size:12px;color:var(--txt3);">No supervisors added yet.</p>';
  const jd=JOBSITE_DATA[site]||{};
  const corfEl=document.getElementById('edit-jobsite-corfix');
  if(corfEl)corfEl.value=jd.corfixUrl||'';
  const jnEl=document.getElementById('edit-jobsite-jobnumber');
  if(jnEl)jnEl.value=jd.jobNumber||'';
  const gcEl=document.getElementById('edit-jobsite-gc');
  if(gcEl)gcEl.value=jd.gc||'';
  const adEl=document.getElementById('edit-jobsite-address');
  if(adEl)adEl.value=jd.address||'';
  document.getElementById('edit-jobsite-modal-bg').style.display='flex';
  setTimeout(()=>{
    const inp=document.getElementById('edit-jobsite-new');
    inp.focus();inp.select();
  },80);
}

function closeEditJobsiteModal(){
  document.getElementById('edit-jobsite-modal-bg').style.display='none';
  _editingJobsiteOldName=null;
}

async function saveJobsiteEdit(){
  const oldName=_editingJobsiteOldName;
  const newName=document.getElementById('edit-jobsite-new').value.trim();
  const err=document.getElementById('edit-jobsite-err');
  if(!newName){err.textContent='Please enter a name.';return}
  if(newName.length<2){err.textContent='Name must be at least 2 characters.';return}
  if(JOBSITES.find(j=>j.toLowerCase()===newName.toLowerCase()&&j!==oldName)){
    err.textContent='A jobsite with that name already exists.';return
  }
  if(ARCHIVED_JOBSITES.find(a=>a.name.toLowerCase()===newName.toLowerCase())){
    err.textContent='That name exists in archives — choose a different name.';return
  }
  // 1. Update the jobsites table
  const ej_corfixUrl=document.getElementById('edit-jobsite-corfix')?.value.trim()||'';
  const ej_jobNumber=document.getElementById('edit-jobsite-jobnumber')?.value.trim()||'';
  const ej_gc=document.getElementById('edit-jobsite-gc')?.value.trim()||'';
  const ej_address=document.getElementById('edit-jobsite-address')?.value.trim()||'';
  const updatePayload={name:newName,corfix_url:ej_corfixUrl||null,job_number:ej_jobNumber||null,gc:ej_gc||null,address:ej_address||null};
  const {error:jsErr}=await sb.from('jobsites').update(updatePayload).eq('name',oldName);
  if(jsErr){err.textContent='DB error: '+jsErr.message;return}
  // Update in-memory JOBSITE_DATA
  const jd=JOBSITE_DATA[oldName]||{};
  JOBSITE_DATA[newName]={...jd,jobNumber:ej_jobNumber,gc:ej_gc,address:ej_address,corfixUrl:ej_corfixUrl};
  if(newName!==oldName)delete JOBSITE_DATA[oldName];
  if(newName===oldName){closeEditJobsiteModal();refreshJobsitePanel();showNotif('✓',`"${newName}" updated`,'Changes saved','#2d7a2d',2400);return}
  // 2. Update all punch records with old jobsite name
  const {error:punchErr}=await sb.from('punches').update({jobsite:newName}).eq('jobsite',oldName);
  if(punchErr){err.textContent='DB error updating punches: '+punchErr.message;return}
  // 3. Update supervisor_jobsites in employees table
  const supEmps=employees.filter(e=>e.dept==='Supervisor'&&(e.supervisorJobsites||[]).includes(oldName));
  for(const se of supEmps){
    const updatedSites=se.supervisorJobsites.map(s=>s===oldName?newName:s);
    await sb.from('employees').update({supervisor_jobsites:updatedSites}).eq('id',se.id);
    se.supervisorJobsites=updatedSites;
  }
  // 4. Update in-memory state
  const idx=JOBSITES.indexOf(oldName);
  if(idx>=0)JOBSITES[idx]=newName;
  timeLog.forEach(e=>{if(e.jobsite===oldName)e.jobsite=newName;});
  supervisors.forEach(s=>{if(s.jobsite===oldName)s.jobsite=newName;});
  if(activeSup&&activeSup.jobsite===oldName)activeSup.jobsite=newName;
  // 5. Update supervisor jobsite assignments for renamed site
  const checkedSupIds=Array.from(document.querySelectorAll('#ej-sup-checks input:checked')).map(c=>parseInt(c.value));
  for(const s of supervisors){
    const had=(s.jobsites||[]).includes(oldName);
    const wants=checkedSupIds.includes(s.id);
    let newSites=[...(s.jobsites||[])];
    if(had&&newName!==oldName){newSites=newSites.map(j=>j===oldName?newName:j);}
    if(!had&&wants){newSites.push(newName);}
    if(had&&!wants){newSites=newSites.filter(j=>j!==newName&&j!==oldName);}
    if(JSON.stringify(newSites)!==JSON.stringify(s.jobsites||[])){
      await sb.from('employees').update({supervisor_jobsites:newSites}).eq('id',s.id);
      s.jobsites=newSites;
    }
  }
  closeEditJobsiteModal();
  refreshAllJobsiteDropdowns();
  refreshJobsitePanel();
  refreshMasterSups();
  refreshMasterOverview();
  showNotif('✓',`"${oldName}" updated`,'Changes saved','#2d7a2d',2600);
}

function confirmRemoveJobsite(site){
  const activeNow=timeLog.filter(l=>l.jobsite===site&&!l.out).length;
  if(activeNow>0){
    showCustomAlert(
      'Cannot archive jobsite',
      `"${site}" has ${activeNow} employee${activeNow!==1?' currently clocked in':' currently clocked in'}. Please clock them out before archiving this jobsite.`
    );
    return;
  }
  const punchCount=timeLog.filter(l=>l.jobsite===site).length;
  const sub=punchCount>0
    ? `${punchCount} punch record${punchCount!==1?'s':''} will be preserved and accessible in the Archived panel.`
    : 'This jobsite has no punch records.';
  showCustomConfirm(
    `Archive "${site}"?`,
    'This jobsite will be removed from the active list and kiosk dropdown.',
    sub,
    'Archive jobsite',
    'var(--amber)',
    ()=>doArchiveJobsite(site,punchCount)
  );
}

async function doArchiveJobsite(site,punchCount){
  const now=new Date();
  const {error}=await sb.from('jobsites').update({archived:true,archived_at:now.toISOString()}).eq('name',site).eq('archived',false);
  if(error){showCustomAlert('Error','Could not archive jobsite: '+error.message);return}
  JOBSITES=JOBSITES.filter(j=>j!==site);
  ARCHIVED_JOBSITES.unshift({name:site,archivedAt:now,punchCount});
  refreshAllJobsiteDropdowns();refreshJobsitePanel();refreshMasterOverview();
  showNotif('🗄',`"${site}" archived`,'Punch data preserved — restore anytime','#c47f17',2800);
}

function restoreJobsite(site){
  if(JOBSITES.find(j=>j.toLowerCase()===site.toLowerCase())){
    showCustomAlert('Already active',`"${site}" is already in the active jobsite list.`);return;
  }
  showCustomConfirm(
    `Restore "${site}"?`,
    'This jobsite will be moved back to the active list and appear in the kiosk dropdown.',
    '',
    'Restore',
    'var(--green)',
    async()=>{
      const {error}=await sb.from('jobsites').update({archived:false,archived_at:null}).eq('name',site);
      if(error){showCustomAlert('Error','Could not restore: '+error.message);return}
      ARCHIVED_JOBSITES=ARCHIVED_JOBSITES.filter(a=>a.name!==site);
      JOBSITES.push(site);
      refreshAllJobsiteDropdowns();refreshJobsitePanel();refreshMasterOverview();
      showNotif('✓',`"${site}" restored`,'Jobsite is active again','#2d7a2d',2400);
    }
  );
}

function viewArchivedPunches(site){
  // Switch to Report tab and pre-filter to this site
  switchMasterTab('log');
  // Wait a tick for panel to render, then set filter
  setTimeout(()=>{
    const sel=document.getElementById('m-filter-site');
    if(sel){
      // Add archived site as temp option if not present
      let found=false;
      for(let o of sel.options){if(o.value===site){found=true;break;}}
      if(!found){const opt=document.createElement('option');opt.value=site;opt.textContent=site+' (archived)';sel.appendChild(opt);}
      sel.value=site;
    }
    setMasterLogPeriod(0,true); // all time
    refreshMasterLog();
  },50);
}

/* ─── PIN ─── */
function pressPin(d){if(currentPin.length<6){currentPin+=d;updatePinDisplay()}}
function clearPin(){currentPin='';updatePinDisplay()}
function backspacePin(){currentPin=currentPin.slice(0,-1);updatePinDisplay()}
function updatePinDisplay(){document.getElementById('pin-display').textContent=currentPin.length===0?'––––':'●'.repeat(currentPin.length)}

/* ─── Notification ─── */
function showNotif(icon,name,action,color,dur=2400){
  const o=document.getElementById('notif-overlay');
  document.getElementById('notif-icon').textContent=icon;
  document.getElementById('notif-name').textContent=name;
  document.getElementById('notif-action').textContent=action;
  document.getElementById('notif-box').style.borderTop=`4px solid ${color}`;
  o.style.display='flex';setTimeout(()=>{o.style.display='none'},dur);
}

/* ─── Submit PIN (with debounce + Supabase) ─── */
let clockBtnBusy=false;
async function submitPin(){
  if(clockBtnBusy)return;
  const btn=document.getElementById('clock-btn');
  clockBtnBusy=true;if(btn)btn.disabled=true;
  setTimeout(()=>{clockBtnBusy=false;if(btn)btn.disabled=false;},2500);

  const pin=currentPin;clearPin();
  const emp=employees.find(e=>e.pin===pin&&e.active);
  if(!emp){showNotif('✗','PIN not recognised','Please try again','#E24B4A');return}

  // Check for open punch in memory first, then DB fallback
  let existing=timeLog.find(e=>e.empId===emp.id&&!e.out);
  if(!existing){
    // Double-check DB in case they punched in on another device
    const {data}=await sb.from('punches').select('*').eq('employee_id',emp.id).is('clock_out',null).maybeSingle();
    if(data){existing=dbRowToEntry(data);timeLog.push(existing);}
  }

  if(existing){
    pendingClockOut={emp,entry:existing};showActivityScreen(emp);
  }else{
    let site=document.getElementById('kiosk-jobsite').value;
    if(!site){showNotif('!','Select a jobsite','Choose your jobsite before clocking in','#EF9F27');return}
    if(site==='__other__'){
      site=document.getElementById('kiosk-other-name').value.trim();
      if(!site){showNotif('!','Enter jobsite name','Please type the temporary jobsite name','#EF9F27');return}
    }
    const now=new Date();
    const entry={empId:emp.id,name:emp.name,dept:emp.dept,jobsite:site,in:now,out:null,activity:[],autoClocked:false};
    // Write to DB
    const {data,error}=await sb.from('punches').insert({
      employee_id:emp.id,employee_name:emp.name,department:emp.dept,
      jobsite:site,clock_in:now.toISOString(),activities:[],auto_clocked:false
    }).select().single();
    if(error){showNotif('✗','Error','Could not save punch — check connection','#E24B4A');return}
    entry.dbId=data.id;
    timeLog.push(entry);
    document.getElementById('kiosk-jobsite').value='';
    document.getElementById('kiosk-other-name').value='';
    document.getElementById('kiosk-other-wrap').style.display='none';
    document.getElementById('kiosk-other-spacer').style.display='block';
    showNotif('✓',emp.name,`Punched in at ${fmt(now)} — ${site}`,'#1D9E75');
    setTimeout(()=>showCorfixReminder(site),600);
  }
}

/* ─── My Timecard (employee self-edit, v41.0) ───
   Employee enters their own PIN to view/correct their punches for the
   CURRENT pay period by default. Once that period has a 'final' submission
   on record, access closes — same lock supervisors/admin already respect.
   All self-edits are written with manual_entry=true so they carry the same
   amber "✎ Manual" badge supervisors already watch for in the logs — no
   separate flag, per Julio's call.
   v45.0: last-period catch-up. If the employee has a worked jobsite from
   LAST period that was never submitted (and isn't already locked by a
   supervisor), a prompt fires on PIN entry offering to review/submit it,
   with a persistent banner as a fallback if dismissed. Reuses this entire
   module against myTcPeriodOffset=1 instead of a parallel code path — see
   refreshMyTcCatchupState/switchMyTcPeriod/renderMyTcPeriodBar below. */
let tcBtnBusy=false;
async function submitTimecardPin(){
  if(tcBtnBusy)return;
  const btn=document.getElementById('timecard-btn');
  tcBtnBusy=true;if(btn)btn.disabled=true;
  setTimeout(()=>{tcBtnBusy=false;if(btn)btn.disabled=false;},2500);

  const pin=currentPin;clearPin();
  const emp=employees.find(e=>e.pin===pin&&e.active);
  if(!emp){showNotif('✗','PIN not recognised','Please try again','#E24B4A');return}
  await openMyTimecard(emp,0);
  // v45.0: fresh check every PIN entry — nudge if last period was never submitted. Not a
  // one-time dismiss: if they tap "Not now" it'll ask again next time, and the banner stays
  // up on the current-period screen in the meantime.
  if(myTcCatchupNeeded){
    const p=myTcCatchupPeriod;
    const periodLabel=`${p.start.toLocaleDateString([],{month:'short',day:'numeric'})} – ${p.end.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;
    showCustomConfirm(
      'Unsubmitted timecard',
      `You have an unsubmitted timecard for ${periodLabel}. Review and submit it now?`,
      'You can switch back to your current period any time from there.',
      'Review now','var(--amber)',
      ()=>switchMyTcPeriod(1));
  }
}

async function openMyTimecard(emp,offset){
  myTcEmp=emp;
  if(offset!=null)myTcPeriodOffset=offset;
  const isCatchup=myTcPeriodOffset===1; // v45.0: viewing last period in catch-up mode
  myTcPeriod=getPeriodByOffset(myTcPeriodOffset);
  document.getElementById('mytc-name').textContent=emp.name+'\u2019s Timecard';
  const from=myTcPeriod.start,to=myTcPeriod.end;
  document.getElementById('mytc-period').textContent=
    `${isCatchup?'Reviewing last pay period':'Current pay period'}: ${from.toLocaleDateString([],{month:'short',day:'numeric'})} – ${to.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;
  document.getElementById('mytc-list').innerHTML='<p style="text-align:center;color:var(--txt2);padding:20px;font-size:13px;">Loading…</p>';
  showScreen('screen-mytc');

  // v47.0: per-site lock model. Build a map of {jobsite: stage} from the status rows.
  // Each punch is editable based on its own site's stage, not a single aggregate.
  myTcStatusRows=await getEmployeeStatusRows(emp.id,myTcPeriod.start);
  const isSupEmp=emp.dept==='Supervisor'; // v46.0
  myTcSiteStageMap={};
  myTcStatusRows.forEach(r=>{myTcSiteStageMap[r.jobsite]=r.stage;});
  // Aggregate flags kept for the top-level locked note and Add button:
  const allStages=Object.values(myTcSiteStageMap);
  const lockThreshold=isSupEmp?TC_STAGE.EXPORTED:TC_STAGE.SUP;
  myTcLocked=allStages.length>0&&allStages.every(s=>stageAtLeast(s,lockThreshold));
  // myTcEditable is now per-punch (checked in renderMyTcList); keep a flag for whether
  // ANY site is open (drives Add button visibility).
  const anyOpen=allStages.length===0||allStages.some(s=>s===TC_STAGE.OPEN)||JOBSITES.some(j=>!myTcSiteStageMap[j]);
  myTcEditable=anyOpen; // still used as "can add" flag
  document.getElementById('mytc-locked-note').textContent=isSupEmp
    ? 'This pay period has already been exported to head office. Contact your GM for any corrections.'
    : 'This pay period has already been submitted. Contact your supervisor for corrections.';
  document.getElementById('mytc-locked-note').style.display=myTcLocked?'block':'none';
  document.getElementById('mytc-add-btn').style.display=anyOpen?'block':'none';

  // Load this employee's punches for the period in view straight from the DB
  // (timeLog only caches open punches, not the full period history)
  const {data:punchData,error}=await sb.from('punches').select('*')
    .eq('employee_id',emp.id)
    .gte('clock_in',from.toISOString())
    .lte('clock_in',to.toISOString())
    .order('clock_in',{ascending:false});
  if(error){
    document.getElementById('mytc-list').innerHTML='<p style="text-align:center;color:var(--red);padding:20px;font-size:13px;">Could not load your punches — check connection.</p>';
    return;
  }
  myTcPunches=(punchData||[]).map(dbRowToEntry);

  // v45.0: only re-check last-period catch-up state while looking at the CURRENT period —
  // this is what feeds both the PIN-entry prompt (submitTimecardPin) and the banner below.
  if(!isCatchup)await refreshMyTcCatchupState(emp);

  renderMyTcSubmitBar();
  renderMyTcTotal();
  renderMyTcList();
  renderMyTcPeriodBar();
}

/* v45.0: does this employee have an unsubmitted LAST period? Re-checked fresh every time the
   current period loads. v47.0: per-site model — show the catch-up banner if ANY site is still
   open (can submit) or pullable (can retract). No longer blocked by a locked site elsewhere. */
async function refreshMyTcCatchupState(emp){
  const period=getPeriodByOffset(1);
  myTcCatchupPeriod=period;
  myTcCatchupNeeded=false;
  const rows=await getEmployeeStatusRows(emp.id,period.start);
  const isSupEmp=emp.dept==='Supervisor';
  const lockThreshold=isSupEmp?TC_STAGE.EXPORTED:TC_STAGE.SUP;
  // v47.0: per-site — if ALL sites are at or past the lock threshold, nothing to catch up on.
  // But if even one site is still open or pullable, show the banner.
  const {data,error}=await sb.from('punches').select('jobsite')
    .eq('employee_id',emp.id)
    .gte('clock_in',period.start.toISOString())
    .lte('clock_in',period.end.toISOString());
  if(error)return;
  const sitesWorked=[...new Set((data||[]).map(p=>p.jobsite).filter(Boolean))];
  if(!sitesWorked.length)return;
  const rowsBySite={};rows.forEach(r=>{rowsBySite[r.jobsite]=r;});
  myTcCatchupNeeded=sitesWorked.some(s=>{
    const r=rowsBySite[s];
    if(!r||r.stage===TC_STAGE.OPEN)return true; // open — needs submit
    if(!stageAtLeast(r.stage,lockThreshold))return true; // submitted but pullable
    return false;
  });
}

/* v45.0: switch the My Timecard view between current (0) and last-period catch-up (1). */
async function switchMyTcPeriod(offset){
  if(myTcBusy||!myTcEmp)return;
  await openMyTimecard(myTcEmp,offset);
}

/* v45.0: banner above the submit bar — a "last period's still open" nudge while viewing
   current, or a "back to current" link while viewing catch-up. Empty/hidden otherwise. */
function renderMyTcPeriodBar(){
  const bar=document.getElementById('mytc-period-bar');
  if(!bar)return;
  const isCatchup=myTcPeriodOffset===1;
  if(isCatchup){
    bar.innerHTML=`<button class="btn-sm" onclick="switchMyTcPeriod(0)" style="background:var(--bg2);color:var(--txt);border:0.5px solid var(--bdr2);">← Back to current period</button>`;
    bar.style.display='block';
    return;
  }
  if(myTcCatchupNeeded&&myTcCatchupPeriod){
    const p=myTcCatchupPeriod;
    const label=`${p.start.toLocaleDateString([],{month:'short',day:'numeric'})} – ${p.end.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;
    bar.innerHTML=`<div onclick="switchMyTcPeriod(1)" style="cursor:pointer;background:var(--amber-l);border:0.5px solid var(--amber);border-radius:var(--radius);padding:10px 12px;">
        <span style="font-size:12px;font-weight:600;color:var(--amber);">⚠️ Unsubmitted timecard for ${label}</span>
        <div style="font-size:11px;color:var(--amber);margin-top:2px;">Tap to review and submit</div>
      </div>`;
    bar.style.display='block';
    return;
  }
  bar.innerHTML='';
  bar.style.display='none';
}

/* Running-hours total + optimistic-waive disclaimer (v44.0) */
function renderMyTcTotal(){
  const el=document.getElementById('mytc-total');
  if(!el)return;
  const {hours,pendingWaiveCount}=myTcRunningHours(myTcPunches);
  const active=myTcPunches.filter(p=>!p.out).length;
  let html=`<div style="display:flex;justify-content:space-between;align-items:baseline;">
      <span style="font-size:12px;color:var(--txt2);">Hours accumulated this period</span>
      <span style="font-size:18px;font-weight:700;color:var(--txt);">${hours.toFixed(2)}h</span>
    </div>`;
  const notes=[];
  if(active)notes.push(`Excludes ${active} punch${active!==1?'es':''} still clocked in.`);
  if(pendingWaiveCount)notes.push(`Includes ${pendingWaiveCount} pending lunch waive${pendingWaiveCount!==1?'s':''} — final hours may be lower if your supervisor denies ${pendingWaiveCount!==1?'them':'it'}.`);
  if(notes.length)html+=`<div style="font-size:11px;color:var(--txt3);margin-top:5px;line-height:1.4;">${notes.join(' ')}</div>`;
  el.innerHTML=html;
}

/* Submit / retract bar at the top of the My Timecard modal (v44.0) */
function renderMyTcSubmitBar(){
  const bar=document.getElementById('mytc-submit-bar');
  if(!bar)return;
  const isSupEmp=myTcEmp&&myTcEmp.dept==='Supervisor'; // v46.0
  const lockThreshold=isSupEmp?TC_STAGE.EXPORTED:TC_STAGE.SUP;
  const pullableStage=isSupEmp?TC_STAGE.SUP:TC_STAGE.EMP;

  // v47.0: per-site categorization
  const workedSites=[...new Set(myTcPunches.map(p=>p.jobsite).filter(Boolean))];
  // Include sites with status rows even if no punches (edge: punches deleted but row remains)
  myTcStatusRows.forEach(r=>{if(!workedSites.includes(r.jobsite))workedSites.push(r.jobsite);});
  const openSites=[],submittedSites=[],lockedSites=[];
  workedSites.forEach(s=>{
    const st=myTcSiteStageMap[s]||TC_STAGE.OPEN;
    if(st===TC_STAGE.OPEN)openSites.push(s);
    else if(st===pullableStage)submittedSites.push(s);
    else if(stageAtLeast(st,lockThreshold))lockedSites.push(s);
    else submittedSites.push(s); // catch-all (shouldn't happen but safe)
  });

  // All locked — no actions
  if(!openSites.length&&!submittedSites.length&&lockedSites.length){
    bar.innerHTML=`<div style="background:var(--bg2);border:0.5px solid var(--bdr2);border-radius:var(--radius);padding:11px 13px;">
        <span style="font-size:13px;font-weight:600;color:var(--txt);">✓ Submitted &amp; locked</span>
        <div style="font-size:11px;color:var(--txt2);margin-top:3px;">${isSupEmp?'This pay period has been exported to head office. Contact your GM for any corrections.':'Your supervisor has submitted this pay period. Contact them for any corrections.'}</div>
      </div>`;
    return;
  }

  let html='';

  // Submitted sites (pullable)
  if(submittedSites.length){
    const siteList=submittedSites.sort().join(', ');
    const subNote=isSupEmp
      ?`Sent to the office (${siteList}). Pull back to make changes before it\u2019s exported.`
      :`Handed in to your supervisor (${siteList}). Pull back to make changes before they submit.`;
    html+=`<div style="background:#173a17;border:0.5px solid #2f7d31;border-radius:var(--radius);padding:11px 13px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div>
            <span style="font-size:13px;font-weight:600;color:#8fe08f;">✓ Submitted${submittedSites.length<workedSites.length?' ('+siteList+')':''}</span>
            <div style="font-size:11px;color:#a9cba9;margin-top:3px;">${subNote}</div>
          </div>
          <button class="btn-sm" id="mytc-retract-btn" onclick="retractMyTimecard()" style="flex-shrink:0;background:var(--bg2);color:var(--txt);border:0.5px solid var(--bdr2);">Pull back</button>
        </div>
      </div>`;
  }

  // Locked sites (non-pullable)
  if(lockedSites.length&&(openSites.length||submittedSites.length)){
    const lockList=lockedSites.sort().join(', ');
    html+=`<div style="background:var(--bg2);border:0.5px solid var(--bdr2);border-radius:var(--radius);padding:8px 13px;margin-bottom:8px;">
        <span style="font-size:11px;color:var(--txt2);">🔒 ${lockList} — ${isSupEmp?'exported, contact your GM':'locked by supervisor'}</span>
      </div>`;
  }

  // Open sites (can submit)
  if(openSites.length){
    const isCatchup=myTcPeriodOffset===1;
    const siteNote=openSites.length<workedSites.length?' ('+openSites.sort().join(', ')+')':'';
    const openHint=isCatchup
      ? 'This is your last pay period — review your punches below, then submit.'
      : (isSupEmp?'As a supervisor, this goes straight to the office once you submit.':'Review your punches below, then submit to hand your timecard to your supervisor.');
    html+=`<button class="btn" id="mytc-submit-btn" onclick="submitMyTimecard()" style="width:100%;background:var(--green);color:#fff;font-weight:600;">Submit my timecard${siteNote} →</button>
      <div style="font-size:11px;color:var(--txt3);margin-top:5px;line-height:1.4;">${openHint}</div>`;
  }

  bar.innerHTML=html;
}

/* Employee submits their timecard (v44.0).
   Gates on auto-clocked punches (blocks → kicks back to fix via Edit).
   Warns if submitting before the pay period has ended; clean submit after. */
async function submitMyTimecard(){
  if(myTcBusy||myTcLocked)return;
  const isSupEmp=myTcEmp&&myTcEmp.dept==='Supervisor'; // v46.0
  // Auto-clock gate — block and point them at the offending punch(es).
  const autos=myTcPunches.filter(p=>p.autoClocked&&!p.editedAfterAuto);
  if(autos.length){
    showCustomAlert('Fix auto-clock-outs first',
      `You have ${autos.length} punch${autos.length!==1?'es'
        :''} that auto-clocked out at 12 hours. Tap Edit on ${autos.length!==1?'each of those punches':'that punch'} below and set your real clock-out time, then submit.`);
    return;
  }
  const beforeEnd=new Date()<myTcPeriod.end;
  const doSubmit=async()=>{
    if(myTcBusy)return;
    myTcBusy=true;
    const btn=document.getElementById('mytc-submit-btn');if(btn)btn.disabled=true;
    // v47.0: only submit sites that are still open (per-site model)
    const allJobsites=[...new Set(myTcPunches.map(p=>p.jobsite).filter(Boolean))];
    const openJobsites=allJobsites.filter(j=>(myTcSiteStageMap[j]||TC_STAGE.OPEN)===TC_STAGE.OPEN);
    if(!openJobsites.length){myTcBusy=false;showCustomAlert('Nothing to submit','No open sites to submit. Your timecard may already be submitted.');return;}
    const targetStage=isSupEmp?TC_STAGE.SUP:TC_STAGE.EMP;
    const results=await Promise.all(openJobsites.map(js=>setTimecardStage(myTcEmp.id,myTcPeriod,targetStage,js)));
    myTcBusy=false;
    const failed=results.filter(r=>!r.ok);
    if(failed.length){showCustomAlert('Could not submit','There was a problem submitting your timecard: '+(failed[0].error?.message||'unknown error')+'. Please try again.');return;}
    const wasCatchup=myTcPeriodOffset===1;
    // v47.0: check if ALL sites are now submitted (open ones just submitted + already-submitted ones)
    const remainingOpen=allJobsites.filter(j=>{
      if(openJobsites.includes(j))return false; // just submitted
      return (myTcSiteStageMap[j]||TC_STAGE.OPEN)===TC_STAGE.OPEN;
    });
    if(wasCatchup&&!remainingOpen.length){
      showNotif('✓','Last period submitted','You\u2019re all caught up','#2f7d31',2600);
      await openMyTimecard(myTcEmp,0);
    } else {
      showNotif('✓','Timecard submitted',isSupEmp?'Sent straight to the office':'Handed in to your supervisor','#2f7d31',2600);
      await openMyTimecard(myTcEmp); // reload → shows updated per-site states
    }
  };
  if(beforeEnd){
    showCustomConfirm(
      'Submit before the period ends?',
      'The current pay period hasn\u2019t ended yet. If you have more shifts coming up this period, wait until after your last punch. Submit anyway?',
      isSupEmp?'You can still pull your timecard back until it\u2019s exported.':'You can still pull your timecard back until your supervisor submits.',
      'Submit anyway','var(--amber)',doSubmit);
  } else {
    doSubmit();
  }
}

/* Employee pulls their submission back (v44.0, reworked v47.0 per-site) — only retracts
   sites that are still pullable (emp_submitted for regular, sup_submitted for supervisors).
   Sites already past the lock threshold are left untouched. */
async function retractMyTimecard(){
  if(myTcBusy)return;
  const isSupEmp=myTcEmp&&myTcEmp.dept==='Supervisor'; // v46.0
  const lockThreshold=isSupEmp?TC_STAGE.EXPORTED:TC_STAGE.SUP;
  const pullableStage=isSupEmp?TC_STAGE.SUP:TC_STAGE.EMP;
  // Guard: re-check ALL site-rows against the DB in case things moved since this screen loaded.
  const fresh=await getEmployeeStatusRows(myTcEmp.id,myTcPeriod.start);
  if(!fresh.length){await openMyTimecard(myTcEmp);return;} // nothing to pull back
  // v47.0: only retract sites that are at the pullable stage — leave locked sites alone
  const pullable=fresh.filter(r=>r.stage===pullableStage);
  if(!pullable.length){
    // Everything is either still open or already locked
    const anyLocked=fresh.some(r=>stageAtLeast(r.stage,lockThreshold));
    if(anyLocked){
      showCustomAlert('Too late to pull back',
        isSupEmp?'Your timecard has already been exported to head office. Contact your GM for any corrections.'
                 :'Your supervisor has already submitted your timecard. Contact them for any corrections.');
    }
    await openMyTimecard(myTcEmp);
    return;
  }
  myTcBusy=true;
  const btn=document.getElementById('mytc-retract-btn');if(btn)btn.disabled=true;
  const results=await Promise.all(pullable.map(r=>setTimecardStage(myTcEmp.id,myTcPeriod,TC_STAGE.OPEN,r.jobsite)));
  myTcBusy=false;
  const failed=results.filter(r=>!r.ok);
  if(failed.length){showCustomAlert('Could not pull back','There was a problem: '+(failed[0].error?.message||'unknown error')+'. Please try again.');return;}
  const siteList=pullable.map(r=>r.jobsite).sort().join(', ');
  showNotif('✓','Pulled back',`${siteList} — you can make changes now`,'#c47f17',2400);
  await openMyTimecard(myTcEmp);
}

function closeMyTimecard(){
  myTcEmp=null;myTcPunches=[];myTcPeriod=null;myTcLocked=false;
  myTcStatusRows=[];myTcBusy=false;myTcEditable=true;
  myTcPeriodOffset=0;myTcCatchupNeeded=false;myTcCatchupPeriod=null;
  myTcSiteStageMap={}; // v47.0
  showScreen('screen-kiosk');
}

function renderMyTcList(){
  const list=document.getElementById('mytc-list');
  if(!myTcPunches.length){
    const msg=myTcPeriodOffset===1?'No punches recorded for that pay period.':'No punches recorded yet this pay period.';
    list.innerHTML=`<p style="text-align:center;color:var(--txt2);padding:24px 10px;font-size:13px;">${msg}</p>`;
    return;
  }
  const isSupEmp=myTcEmp&&myTcEmp.dept==='Supervisor';
  const lockThreshold=isSupEmp?TC_STAGE.EXPORTED:TC_STAGE.SUP;
  list.innerHTML=myTcPunches.map(e=>{
    // v47.0: per-punch editability based on its own site's stage
    const punchStage=myTcSiteStageMap[e.jobsite]||TC_STAGE.OPEN;
    const punchEditable=(punchStage===TC_STAGE.OPEN);
    const punchLocked=stageAtLeast(punchStage,lockThreshold);
    const stillIn=!e.out;
    const badges=[
      stillIn?'<span class="badge b-in">In</span>':'',
      e.manualEntry?'<span class="badge b-amber">✎ Manual</span>':'',
      e.autoClocked?'<span class="badge" style="background:#3a1f1f;color:#e08585;">Auto-clocked</span>':'',
      punchLocked?'<span class="badge" style="background:var(--bg3);color:var(--txt3);font-size:9px;">🔒</span>':'',
      (!punchEditable&&!punchLocked)?'<span class="badge" style="background:var(--amber-l);color:var(--amber);font-size:9px;">Submitted</span>':''
    ].filter(Boolean).join(' ');
    return `<div class="card" style="margin-bottom:10px;${punchLocked?'opacity:0.65;':''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div>
          <div style="font-weight:600;font-size:13px;color:var(--txt);">${fmtDt(e.in)}</div>
          <div style="font-size:12px;color:var(--txt2);margin-top:2px;">${e.jobsite||'—'}</div>
          <div style="font-size:12px;color:var(--txt2);margin-top:2px;">
            In: ${fmt(e.in)} &nbsp;→&nbsp; Out: ${e.out?fmt(e.out):'—'}
          </div>
          ${(e.activity&&e.activity.length)?`<div style="font-size:11px;color:var(--txt3);margin-top:4px;">${e.activity.join(', ')}</div>`:''}
        </div>
        <div style="text-align:right;">${badges}</div>
      </div>
      ${punchEditable?`<div style="margin-top:8px;text-align:right;"><button class="btn-sm" onclick="openMyTcEdit('${e.dbId}')">Edit</button></div>`:''}
    </div>`;
  }).join('');
}

/* Add a missed punch — simplified flow, scoped to self + current period only */
function openMyTcAdd(){
  // v47.0: per-site — only open if at least one site is open; offer only open sites
  const openSites=JOBSITES.filter(j=>(myTcSiteStageMap[j]||TC_STAGE.OPEN)===TC_STAGE.OPEN);
  if(!openSites.length)return;
  myTcAdding=true;myTcEditingDbId=null;myTcEditActs=new Set();
  document.getElementById('mytc-edit-title').textContent='Add a missed punch';
  document.getElementById('mytc-edit-in').value='';
  document.getElementById('mytc-edit-out').value='';
  document.getElementById('mytc-edit-jobsite').innerHTML=openSites.map(j=>`<option>${j}</option>`).join('');
  buildMyTcActGrid();
  // v47.0: show add-mode quick-set buttons
  document.getElementById('mytc-in-quickset-add').style.display='flex';
  document.getElementById('mytc-out-quickset-add').style.display='flex';
  document.getElementById('mytc-out-quickset-edit').style.display='none';
  document.getElementById('mytc-edit-err').textContent='';
  document.getElementById('mytc-edit-modal-bg').style.display='flex';
}

function openMyTcEdit(dbId){
  // v47.0: per-site editability — check this punch's site stage
  const e=myTcPunches.find(p=>String(p.dbId)===String(dbId));
  if(!e)return;
  const punchStage=myTcSiteStageMap[e.jobsite]||TC_STAGE.OPEN;
  if(punchStage!==TC_STAGE.OPEN)return; // locked at this site
  myTcAdding=false;myTcEditingDbId=dbId;myTcEditActs=new Set(e.activity||[]);
  document.getElementById('mytc-edit-title').textContent='Edit my punch';
  document.getElementById('mytc-edit-in').value=toLocal(e.in);
  document.getElementById('mytc-edit-out').value=e.out?toLocal(e.out):'';
  document.getElementById('mytc-edit-jobsite').innerHTML=JOBSITES.map(j=>`<option${e.jobsite===j?' selected':''}>${j}</option>`).join('');
  buildMyTcActGrid();
  // v47.0: show edit-mode quick-set buttons (out only, on same date as clock-in)
  document.getElementById('mytc-in-quickset-add').style.display='none';
  document.getElementById('mytc-out-quickset-add').style.display='none';
  document.getElementById('mytc-out-quickset-edit').style.display='flex';
  document.getElementById('mytc-edit-err').textContent='';
  document.getElementById('mytc-edit-modal-bg').style.display='flex';
}

function buildMyTcActGrid(){
  document.getElementById('mytc-edit-act-grid').innerHTML=[...ACTIVITIES].sort((a,b)=>a.name.localeCompare(b.name)).map(a=>
    `<button type="button" class="act-btn${myTcEditActs.has(a.name)?' sel':''}" id="mtcact_${a.name.replace(/\s/g,'_')}" onclick="toggleMyTcAct('${a.name.replace(/'/g,"\\'")}')">${a.name}</button>`
  ).join('');
}
function toggleMyTcAct(a){
  if(myTcEditActs.has(a))myTcEditActs.delete(a);else myTcEditActs.add(a);
  const el=document.getElementById('mtcact_'+a.replace(/\s/g,'_'));
  if(el)el.classList.toggle('sel',myTcEditActs.has(a));
}
function closeMyTcEditModal(){
  document.getElementById('mytc-edit-modal-bg').style.display='none';
  myTcEditingDbId=null;myTcAdding=false;
}

async function saveMyTcEdit(){
  const err=document.getElementById('mytc-edit-err');
  const inV=document.getElementById('mytc-edit-in').value;
  const outV=document.getElementById('mytc-edit-out').value;
  if(!inV){err.textContent='Clock in time is required.';return}
  const newIn=new Date(inV);
  const newOut=outV?new Date(outV):null;
  if(newOut&&newOut<=newIn){err.textContent='Clock out must be after clock in.';return}
  // Guardrail: stays within whichever period is currently in view (current, or last-period catch-up)
  const periodLabel=myTcPeriodOffset===1?'the last':'the current';
  if(newIn<myTcPeriod.start||newIn>myTcPeriod.end){err.textContent=`Clock in must fall within ${periodLabel} pay period.`;return}
  if(newOut&&(newOut<myTcPeriod.start||newOut>myTcPeriod.end)){err.textContent=`Clock out must fall within ${periodLabel} pay period.`;return}
  const jobsite=document.getElementById('mytc-edit-jobsite').value;
  const acts=[...myTcEditActs];
  const emp=myTcEmp;

  if(myTcAdding){
    const payload={
      employee_id:emp.id,employee_name:emp.name,department:emp.dept,
      jobsite,clock_in:newIn.toISOString(),
      clock_out:newOut?newOut.toISOString():null,
      activities:acts,auto_clocked:false,manual_entry:true
    };
    const {error}=await sb.from('punches').insert(payload);
    if(error){err.textContent='DB error: '+error.message;return}
    closeMyTcEditModal();
    showNotif('✓','Punch added','Saved to your timecard','#2f7d31',2600);
  } else {
    const e=myTcPunches.find(p=>String(p.dbId)===String(myTcEditingDbId));
    if(!e){err.textContent='Punch not found — reopen and try again.';return}
    const oldJobsite=e.jobsite,oldIn=e.in; // v47.4: capture pre-edit site/date for orphan cleanup
    const wasAuto=e.autoClocked;
    const editedAfterAuto=wasAuto&&!!newOut;
    const upd={clock_in:newIn.toISOString(),jobsite,activities:acts,manual_entry:true};
    upd.clock_out=newOut?newOut.toISOString():null;
    if(editedAfterAuto){upd.auto_clocked=false;upd.edited_after_auto=true;}
    const {error}=await sb.from('punches').update(upd).eq('id',e.dbId);
    if(error){err.textContent='DB error: '+error.message;return}
    // Keep the in-memory open-punch cache consistent for this device too
    const memEntry=timeLog.find(l=>l.dbId===e.dbId);
    if(memEntry){
      memEntry.in=newIn;memEntry.out=newOut;memEntry.jobsite=jobsite;memEntry.activity=acts;memEntry.manualEntry=true;
      if(editedAfterAuto){memEntry.autoClocked=false;memEntry.editedAfterAuto=true;}
      if(newOut){const idx=timeLog.indexOf(memEntry);if(idx>=0)timeLog.splice(idx,1);}
    }
    // v47.4: if this edit left the OLD site with no punches this period, drop its stale status row
    await cleanupOrphanStatusRow(emp.id,oldJobsite,periodContaining(oldIn));
    closeMyTcEditModal();
    showNotif('✓','Punch updated','Saved to your timecard','#2f7d31',2600);
  }
  await openMyTimecard(emp);
}

/* ─── Activity screen (v39.0 — full-screen checklist, replaces v36–v38 dropdown) ─── */
function showActivityScreen(emp){
  document.getElementById('activity-emp-name').textContent=emp.name;
  selectedActs=new Set();
  document.getElementById('activity-error').textContent='';
  // Reset the lunch-waive request toggle each time (v42.0)
  lunchWaiveRequested=false;
  const lw=document.getElementById('lunch-waive-chk');if(lw)lw.checked=false;
  renderActList();
  showScreen('screen-activity');
  window.scrollTo(0,0); // this screen always starts at the top of the list
  requestAnimationFrame(updateActScroll);
}

function renderActList(){
  const list=document.getElementById('act-list');
  // v43.0: activities shown alphabetically (was sort_order)
  const sorted=[...ACTIVITIES].sort((a,b)=>a.name.localeCompare(b.name));
  list.innerHTML=sorted.map(a=>`
    <div class="act-list-item${selectedActs.has(a.name)?' checked':''}" id="aitem_${a.id}" onclick="toggleAct('${a.name.replace(/'/g,"\'")}',${a.id})">
      <input type="checkbox" ${selectedActs.has(a.name)?'checked':''} onclick="event.stopPropagation()" onchange="toggleAct('${a.name.replace(/'/g,"\'")}',${a.id})" style="pointer-events:none;"/>
      <span>${a.name}</span>
    </div>`).join('');
}

function toggleAct(name,id){
  if(selectedActs.has(name))selectedActs.delete(name);
  else selectedActs.add(name);
  document.getElementById('activity-error').textContent='';
  // Update just this item in place — avoids a full re-render on every tap
  const item=document.getElementById('aitem_'+id);
  if(item){
    const chk=item.querySelector('input[type=checkbox]');
    const checked=selectedActs.has(name);
    if(chk)chk.checked=checked;
    item.classList.toggle('checked',checked);
  }
}

// Lunch waive request toggle (v42.0) — clock-out screen.
function toggleLunchWaive(){
  lunchWaiveRequested=!lunchWaiveRequested;
  const chk=document.getElementById('lunch-waive-chk');
  if(chk)chk.checked=lunchWaiveRequested;
}

// Custom page-scroll affordance for the activity screen (v39.1) — driven by
// real window-scroll math rather than native scrollbar/CSS, since native
// scrollbars are unreliable on mobile/PWA. Guarded on the screen being
// active so it's a no-op (cheap check, no layout read) on every other screen.
function updateActScroll(){
  const screen=document.getElementById('screen-activity');
  if(!screen||!screen.classList.contains('active'))return;
  const rail=document.querySelector('.act-scroll-rail');
  const thumb=document.getElementById('act-scroll-thumb');
  const arrowTop=document.getElementById('act-arrow-top');
  const arrowBottom=document.getElementById('act-arrow-bottom');
  if(!rail||!thumb)return;
  const scrollY=window.scrollY||document.documentElement.scrollTop;
  const scrollHeight=document.documentElement.scrollHeight;
  const viewport=window.innerHeight;
  const scrollable=scrollHeight>viewport+2;
  const railHeight=rail.clientHeight;
  if(scrollable&&railHeight>0){
    const maxScroll=scrollHeight-viewport;
    const thumbHeight=Math.max(24,railHeight*(viewport/scrollHeight));
    thumb.style.height=thumbHeight+'px';
    thumb.style.top=((railHeight-thumbHeight)*(scrollY/maxScroll))+'px';
    thumb.style.display='block';
  }else{
    thumb.style.display='none';
  }
  const showTop=scrollable&&scrollY>4;
  const showBottom=scrollable&&scrollY<scrollHeight-viewport-4;
  if(arrowTop)arrowTop.classList.toggle('show',showTop);
  if(arrowBottom)arrowBottom.classList.toggle('show',showBottom);
}
function scrollActivityBy(dir){
  window.scrollBy({top:dir*Math.round(window.innerHeight*0.6),behavior:'smooth'});
}
window.addEventListener('scroll',updateActScroll,{passive:true});
window.addEventListener('resize',updateActScroll,{passive:true});

async function confirmClockOut(){
  if(selectedActs.size===0){document.getElementById('activity-error').textContent='Please select at least one activity.';return}
  const now=new Date();
  const entry=pendingClockOut.entry;
  const name=pendingClockOut.emp.name;
  entry.out=now;entry.activity=[...selectedActs];
  entry.lunchWaiveRequested=lunchWaiveRequested; // v42.0
  // Write to DB
  if(entry.dbId){
    const {error}=await sb.from('punches').update({
      clock_out:now.toISOString(),
      activities:[...selectedActs],
      auto_clocked:false,
      lunch_waive_requested:lunchWaiveRequested
    }).eq('id',entry.dbId);
    if(error){showNotif('✗','Error','Could not save clock-out — check connection','#E24B4A');return}
  }
  pendingClockOut=null;
  showScreen('screen-kiosk');showNotif('✓',name,`Punched out at ${fmt(now)}`,'#2d7a2d');
}
function cancelClockOut(){pendingClockOut=null;showScreen('screen-kiosk')}


/* ─── Corfix safety reminder ─── */
let _corfixUrl='';
function showCorfixReminder(siteName){
  const jd=JOBSITE_DATA[siteName]||{};
  _corfixUrl=jd.corfixUrl||'';
  document.getElementById('corfix-modal-msg').textContent='Please complete your safety paperwork before starting work at '+siteName+'.';
  const goBtn=document.getElementById('corfix-go-btn');
  if(_corfixUrl){
    goBtn.style.display='';
    goBtn.textContent='Open Corfix →';
  } else {
    goBtn.style.display='none';
  }
  document.getElementById('corfix-modal-bg').style.display='flex';
}
function closeCorfixModal(){document.getElementById('corfix-modal-bg').style.display='none';_corfixUrl='';}
function openCorfixLink(){if(_corfixUrl)window.open(_corfixUrl,'_blank');closeCorfixModal();}

/* ─── Screen switching ─── */
function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active')}
function showKiosk(){
  stopSupTimeout();stopMasterTimeout();activeSup=null;
  showScreen('screen-kiosk');
}
function showMasterLogin(){showScreen('screen-master-login');document.getElementById('master-pass-inp').value='';document.getElementById('master-login-err').textContent=''}
function showSupLogin(){
  // v44.1: name dropdown removed — supervisor logs in with password only (unique password
  // enforced at both app-layer and DB-layer). Autofocus the password field since it's the
  // only input on screen now.
  document.getElementById('sup-login-pass').value='';document.getElementById('sup-login-err').textContent='';
  showScreen('screen-sup-login');
  setTimeout(()=>{const p=document.getElementById('sup-login-pass');if(p)p.focus();},80);
}
function masterLogin(){
  if(document.getElementById('master-pass-inp').value===MASTER_PASSWORD){
    stopSupTimeout();
    startMasterTimeout();
    localStorage.setItem('pt_session',JSON.stringify({type:'master',ts:Date.now()}));
  startMasterTimeout();
  showScreen('screen-master');switchMasterTab('overview');
  } else {document.getElementById('master-login-err').textContent='Incorrect master password.';}
}
function supLogin(){
  // v44.1: password-only login. Every supervisor password is unique (enforced at save time
  // and by a DB UNIQUE constraint on employees.supervisor_password), so one password
  // resolves to exactly one supervisor.
  const pass=document.getElementById('sup-login-pass').value;
  if(!pass){document.getElementById('sup-login-err').textContent='Enter your supervisor password.';return}
  const sup=supervisors.find(s=>s.password===pass);
  if(!sup){document.getElementById('sup-login-err').textContent='Incorrect password.';return}
  activeSup={...sup, jobsites:sup.jobsites||[]};
  // activeSupSite = currently selected site for log/export (defaults to first)
  activeSup.activeSite = activeSup.jobsites[0]||null;
  document.getElementById('sup-dash-title').textContent=sup.name;
  const siteLabel=activeSup.jobsites.length>1
    ? activeSup.jobsites.join(' · ')
    : (activeSup.jobsites[0]||'No sites assigned');
  document.getElementById('sup-dash-site').textContent=`Supervising: ${siteLabel}`;
  stopMasterTimeout();startSupTimeout();
  localStorage.setItem('pt_session',JSON.stringify({type:'sup',supId:activeSup.id,ts:Date.now()}));
  startSupTimeout();
  showScreen('screen-sup');switchSupTab('live');
  checkPrelimReminder();
}

/* ─── Supervisor tabs ─── */
function switchSupTab(tab){
  ['live','log','employees'].forEach(t=>{
    document.getElementById('spanel-'+t).style.display=t===tab?'block':'none';
    document.getElementById('stab-'+t).classList.toggle('active',t===tab);
  });
  if(tab==='live')refreshSupLive();
  if(tab==='log'){initLogDates();}
  if(tab==='employees')refreshSupEmps();
}

/* elapsed helper */
function elapsed(entry){
  const ms=new Date()-entry.in;
  return `${Math.floor(ms/3600000)}h ${Math.floor((ms%3600000)/60000)}m`;
}

/* ─── Supervisor: Live ─── */
async function refreshSupLive(){
  if(!activeSup)return;
  const sites=activeSup.jobsites||[];
  const siteLogs=timeLog.filter(l=>sites.includes(l.jobsite));
  const active=siteLogs.filter(l=>!l.out);
  const todayStart=new Date();todayStart.setHours(0,0,0,0);
  const yestStart=new Date(todayStart);yestStart.setDate(yestStart.getDate()-1);
  const yestEnd=new Date(todayStart);yestEnd.setMilliseconds(-1);
  document.getElementById('s-stat-in').textContent=active.length;
  const yestEmps=new Set(siteLogs.filter(l=>l.in>=yestStart&&l.in<=yestEnd).map(l=>l.empId));
  document.getElementById('s-stat-total').textContent=yestEmps.size;
  // Query DB for outstanding-review count scoped to this supervisor's sites.
  // v42.0: count = uncorrected auto-clocks + pending lunch-waive requests.
  const {count:autoCount}=await sb.from('punches')
    .select('*',{count:'exact',head:true})
    .in('jobsite',sites)
    .eq('auto_clocked',true)
    .eq('edited_after_auto',false);
  const {count:waiveCount}=await sb.from('punches')
    .select('*',{count:'exact',head:true})
    .in('jobsite',sites)
    .eq('lunch_waive_requested',true)
    .is('lunch_waived',null);
  document.getElementById('s-stat-punches').textContent=(autoCount||0)+(waiveCount||0);
  const tbody=document.getElementById('s-live-table');
  if(!active.length){tbody.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--txt2);padding:20px;">No employees currently clocked in</td></tr>';return}
  tbody.innerHTML=active.map(l=>`<tr><td>${l.name}</td><td>${sites.length>1?`<span class="badge b-blue" style="font-size:10px;">${l.jobsite}</span>`:''}</td><td><span class="badge b-in">In</span></td><td>${elapsed(l)}</td><td>${l.dept}</td></tr>`).join('');
}

/* ─── Pay period calculator ───
   Anchor: period ending Sun May 17 2026 → period start Mon May 4 2026
   Every period = 14 days, Mon–Sun ─── */
const PERIOD_ANCHOR_END=new Date(2026,4,17,23,59,59,999); // May 17 2026

function getPeriodByOffset(offset){
  // offset 0 = current period, 1 = last (most recent completed), 2 = two periods ago
  const anchorEnd=PERIOD_ANCHOR_END;
  const now=new Date();
  // How many complete periods since anchor?
  const msSinceAnchor=now-anchorEnd;
  const periodsSinceAnchor=Math.floor(msSinceAnchor/(14*24*3600*1000));
  // Period index: 0 = current in-progress period
  // current period start = anchorEnd + (periodsSinceAnchor)*14days + 1ms
  // current period end   = anchorEnd + (periodsSinceAnchor+1)*14days
  const MS14=14*24*3600*1000;
  let periodEnd,periodStart;
  if(msSinceAnchor<0){
    // We are still in or before the anchor period
    periodEnd=new Date(anchorEnd);
    periodStart=new Date(anchorEnd.getTime()-MS14+1000);
  } else {
    periodEnd=new Date(anchorEnd.getTime()+(periodsSinceAnchor+1)*MS14);
    periodStart=new Date(periodEnd.getTime()-MS14+1000);
  }
  // apply offset backwards
  const start=new Date(periodStart.getTime()-offset*MS14);
  const end=new Date(periodEnd.getTime()-offset*MS14);
  end.setHours(23,59,59,999);
  start.setHours(0,0,0,0);
  return {start,end};
}

function isCompleted(period){
  return period.end<new Date();
}

/* ─── Supervisor: Log period selection ─── */
let _supPeriodMode='current'; // default to current period on open

function initLogDates(){
  setSupPeriod('current');
}

function setSupPeriod(mode){
  _supPeriodMode=mode;
  const _ff=document.getElementById('s-filter-flags');if(_ff)_ff.value='';
  // highlight active button
  ['today','yesterday','current','last','prev2'].forEach(m=>{
    const btn=document.getElementById('spbtn-'+m);
    if(btn)btn.style.fontWeight=m===mode?'700':'500';
    if(btn)btn.style.background=m===mode?'var(--blue-l)':'';
    if(btn)btn.style.color=m===mode?'var(--blue-d)':'';
  });

  const now=new Date();
  let from,to,exportable=false,label='';

  if(mode==='today'){
    from=new Date(now);from.setHours(0,0,0,0);
    to=new Date(now);to.setHours(23,59,59,999);
    label=fmtDate(now);
    exportable=false;
  } else if(mode==='yesterday'){
    const y=new Date(now);y.setDate(y.getDate()-1);
    from=new Date(y);from.setHours(0,0,0,0);
    to=new Date(y);to.setHours(23,59,59,999);
    label=fmtDate(y);
    exportable=false;
  } else if(mode==='current'){
    const p=getPeriodByOffset(0);
    from=p.start;to=p.end;
    label=`${from.toLocaleDateString([],{month:'short',day:'numeric'})} – ${to.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;
    exportable=false;
  } else if(mode==='last'){
    const p=getPeriodByOffset(1);
    from=p.start;to=p.end;
    label=`${from.toLocaleDateString([],{month:'short',day:'numeric'})} – ${to.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;
    exportable=isCompleted(p);
  } else if(mode==='prev2'){
    const p=getPeriodByOffset(2);
    from=p.start;to=p.end;
    label=`${from.toLocaleDateString([],{month:'short',day:'numeric'})} – ${to.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;
    exportable=isCompleted(p);
  }

  document.getElementById('s-period-label').textContent=label;
  document.getElementById('s-log-from').value=toDateStr(from);
  document.getElementById('s-log-to').value=toDateStr(to);

  const exportBtn=document.getElementById('s-export-btn');
  const exportNote=document.getElementById('s-export-note');
  // v44.0: the supervisor PDF is now a PREVIEW tool — the office does the official export
  // from the submitted timecards. Machinery is unchanged; only the wording is preview-framed.
  exportBtn.style.display='block';
  if(exportable){
    exportNote.textContent='';
    exportBtn.textContent='Preview PDF →';
  } else {
    if(mode==='today'||mode==='yesterday'){
      exportNote.textContent='Note: This is a partial day view.';
      exportBtn.textContent='Preview PDF (partial) →';
    } else if(mode==='current'){
      exportNote.textContent='Period in progress — this generates a preliminary preview.';
      exportBtn.textContent='Preview PDF (preliminary) →';
    }
  }

  // v44.0: label the "Submit site to office" button with the period it will actually submit
  // (supStatusPeriod(): today/yesterday/current → current period; last/prev2 → that period).
  const submitLabel=document.getElementById('s-submit-period-label');
  if(submitLabel){
    const sp=(mode==='last')?getPeriodByOffset(1):(mode==='prev2')?getPeriodByOffset(2):getPeriodByOffset(0);
    submitLabel.textContent=`${sp.start.toLocaleDateString([],{month:'short',day:'numeric'})} – ${sp.end.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;
  }
  // Store period info for export
  exportRange={...exportRange,from,to,periodMode:mode};
  refreshSupLog();
  if(exportable)updateExportPreview();
  else{
    const prev=document.getElementById('s-export-preview');
    if(prev)prev.textContent='';
    const err=document.getElementById('s-export-err');
    if(err)err.textContent='';
  }
}

/* ─── Supervisor: Log (per-employee accordion) ─── */
let _supLogSeq=0; // v40.1: race guard — only the most recently-initiated call may render

/* Which pay period do the submission stages belong to for the current log view? (v44.0)
   Employees submit against getPeriodByOffset(0); today/yesterday are partial views of
   that same in-progress period, so they all map to offset 0. 'last'/'prev2' map back. */
function supStatusPeriod(){
  if(_supPeriodMode==='last')return getPeriodByOffset(1);
  if(_supPeriodMode==='prev2')return getPeriodByOffset(2);
  return getPeriodByOffset(0);
}
/* Stage → chip styling for the supervisor log (v44.0). Distinct hues, not the near-identical
   blue/green pair: grey (nothing yet) → amber (needs the supervisor's review) → green (handed off). */
function supStageChip(stage){
  if(stageAtLeast(stage,TC_STAGE.SUP))
    return {label:'✓ Sent to office',bg:'var(--green-l)',color:'var(--green)',border:'var(--green)'};
  if(stage===TC_STAGE.EMP)
    return {label:'✓ Submitted — review',bg:'var(--amber-l)',color:'var(--amber)',border:'var(--amber)'};
  return {label:'Not submitted',bg:'var(--bg3)',color:'var(--txt2)',border:'var(--bdr2)'};
}

async function refreshSupLog(){
  const _mySeq=++_supLogSeq;
  await checkAutoServer();if(!activeSup)return;
  const sites=activeSup.jobsites||[];
  const filter=document.getElementById('s-filter-flags')?.value||'';
  let logs=[];

  if(filter==='review'){
    // Needs review only: ALL outstanding items at supervisor's sites (period-independent, matches the Live tile count).
    // v42.0: now includes pending lunch-waive requests in addition to uncorrected auto-clocks.
    const {data,error}=await sb.from('punches').select('*')
      .in('jobsite',sites)
      .or('and(auto_clocked.eq.true,edited_after_auto.eq.false),and(lunch_waive_requested.eq.true,lunch_waived.is.null)')
      .order('clock_in',{ascending:false});
    if(error){showCustomAlert('Error','Could not load log: '+error.message);return}
    logs=(data||[]).map(dbRowToEntry);
    const lbl=document.getElementById('s-period-label');if(lbl)lbl.textContent='All outstanding review items';
  } else {
    const fromV=document.getElementById('s-log-from').value;
    const toV=document.getElementById('s-log-to').value;
    let from=null,to=null;
    if(fromV){const[fy,fm,fd]=fromV.split('-').map(Number);from=new Date(fy,fm-1,fd,0,0,0,0);}
    if(toV){const[ty,tm,td]=toV.split('-').map(Number);to=new Date(ty,tm-1,td,23,59,59,999);}

    // Two-step query: find employees with any punch at supervisor's sites, then get ALL their punches
    let siteQuery=sb.from('punches').select('employee_id').in('jobsite',sites);
    if(from)siteQuery=siteQuery.gte('clock_in',from.toISOString());
    if(to)siteQuery=siteQuery.lte('clock_in',to.toISOString());
    const {data:siteData,error:siteErr}=await siteQuery;
    if(siteErr){showCustomAlert('Error','Could not load log: '+siteErr.message);return}

    const empIds=[...new Set((siteData||[]).map(r=>r.employee_id).filter(Boolean))];
    if(empIds.length){
      // Also include open in-memory punches at supervisor's sites
      const openAtSite=timeLog.filter(l=>sites.includes(l.jobsite)&&!l.dbId&&l.empId);
      openAtSite.forEach(l=>{if(!empIds.includes(l.empId))empIds.push(l.empId);});

      // Fetch ALL punches for these employees in the date range (any site)
      let allQuery=sb.from('punches').select('*').in('employee_id',empIds).order('clock_in',{ascending:false});
      if(from)allQuery=allQuery.gte('clock_in',from.toISOString());
      if(to)allQuery=allQuery.lte('clock_in',to.toISOString());
      const {data,error}=await allQuery;
      if(error){showCustomAlert('Error','Could not load log: '+error.message);return}
      logs=(data||[]).map(dbRowToEntry);
      // Merge open in-memory punches for these employees not yet in DB
      timeLog.filter(l=>empIds.includes(l.empId)&&!l.dbId).forEach(l=>{
        if(!from||l.in>=from)if(!to||l.in<=to)logs.unshift(l);
      });
    }
    if(filter==='stillin')logs=logs.filter(l=>!l.out);
  }

  if(_mySeq!==_supLogSeq)return; // a newer call has superseded this one — drop the stale render

  // v44.0 (Option A): one submission-stage query per refresh, mapped by employee_id → array of
  // site-rows (Build 3: one row per jobsite). Colours the per-employee cards by stage and
  // surfaces out-of-submission punches + Force Submit for stragglers at this supervisor's sites.
  const statusPeriod=supStatusPeriod();
  const statusMap=await getAllStatusForPeriod(statusPeriod.start);
  if(_mySeq!==_supLogSeq)return; // re-guard: the extra async call could have been superseded

  // Update export preview with same date range
  updateExportPreview();
  const container=document.getElementById('s-log-accordion');
  if(!logs.length){
    container.innerHTML='<p style="color:var(--txt2);text-align:center;padding:24px 0;font-size:13px;">No records for this period</p>';
    updateSubmitSummary({},{});
    return;
  }

  // Group by employee
  const empMap={};
  logs.forEach(l=>{
    if(!empMap[l.empId])empMap[l.empId]={name:l.name,dept:l.dept,records:[]};
    empMap[l.empId].records.push(l);
  });

  const myStatusMap={}; // v44.0 Build 3: per-employee status rows scoped to this supervisor's sites (for updateSubmitSummary)
  container.innerHTML=Object.entries(empMap).map(([empId,data])=>{
    const records=data.records;
    // v44.0 Build 3: this employee's status rows scoped to THIS supervisor's own jobsites
    // (they may also have rows at other sites/supervisors — not this card's concern).
    const allRows=statusMap[empId]||[];
    const mySiteRows=allRows.filter(r=>sites.includes(r.jobsite));
    myStatusMap[empId]=mySiteRows;
    const stage=minStage(mySiteRows); // least-advanced site = what still needs attention
    const chip=supStageChip(stage);
    // out-of-submission: match each punch to ITS OWN site's row (not a single shared row).
    const oos=records.filter(l=>isOutOfSubmission(l,mySiteRows.find(r=>r.jobsite===l.jobsite)||null)).length;
    const totalHrs=records.reduce((s,l)=>s+(paidHours(l)||0),0);
    const flags=records.filter(l=>l.autoClocked).length;
    const waivePend=records.filter(l=>isPendingWaive(l)).length;
    const still=records.filter(l=>!l.out).length;
    // Force Submit (v44.0 Build 3, widened v44.2): sites among this supervisor's own jobsites
    // where this employee has punches this period but no valid submission — either no status
    // row yet (never submitted) OR a row that exists but is back at 'open' (pulled back).
    // A pulled-back row is functionally identical to a never-submitted one from the supervisor's
    // perspective: the employee has punches and no live submission, so Force Submit still
    // applies. No UI differentiation between the two — the button looks the same in both cases.
    const mySiteRowsBySite={};mySiteRows.forEach(r=>{mySiteRowsBySite[r.jobsite]=r;});
    const recordSites=[...new Set(records.filter(l=>sites.includes(l.jobsite)).map(l=>l.jobsite))];
    const openSupSites=recordSites.filter(s=>{
      const r=mySiteRowsBySite[s];
      return !r || r.stage===TC_STAGE.OPEN;
    });
    const forceBtn=openSupSites.length
      ? `<button class="btn-sm" onclick="event.stopPropagation();forceSubmitEmployee('${empId}','${data.name.replace(/'/g,"\\'")}')" style="background:var(--amber-l);color:var(--amber);border:0.5px solid var(--amber);margin-left:6px;">Force submit</button>`
      : '';
    // v47.0: supervisor "Send back to employee" — available for sites at sup_submitted (sent
    // to office but not yet exported). Sends back to open at this supervisor's own sites only.
    const sentBackSites=mySiteRows.filter(r=>r.stage===TC_STAGE.SUP&&!allRows.some(ar=>ar.stage===TC_STAGE.EXPORTED));
    const sendBackBtn=sentBackSites.length
      ? `<button class="btn-sm" onclick="event.stopPropagation();supSendBackToEmployee('${empId}','${data.name.replace(/'/g,"\\'")}')" style="background:var(--bg2);color:var(--txt2);border:0.5px solid var(--bdr2);margin-left:6px;">Send back</button>`
      : '';
    // v47.3: per-employee "Send to office" — counterpart to the batch bar button below.
    // Available for sites at emp_submitted under this supervisor. Lets a supervisor review
    // and send one employee at a time instead of firing the whole batch. Coexists with
    // Force Submit (sites at open) and Send Back (sites at sup_submitted) when the employee
    // is straddling states across the supervisor's sites.
    const sendableSites=mySiteRows.filter(r=>sites.includes(r.jobsite)&&r.stage===TC_STAGE.EMP);
    const sendBtn=sendableSites.length
      ? `<button class="btn-sm" onclick="event.stopPropagation();supSendEmployeeToOffice('${empId}','${data.name.replace(/'/g,"\\'")}')" style="background:var(--green-l,#d8f0d8);color:var(--green,#2f7d31);border:0.5px solid var(--green,#2f7d31);margin-left:6px;">Send to office</button>`
      : '';
    const summary=`${records.length} punch${records.length!==1?'es':''} · ${totalHrs.toFixed(1)}h${flags?` · <span style="color:#e07070;font-weight:600;">${flags} ⚠️ needs review</span>`:''}${waivePend?` · <span style="color:#c47f17;font-weight:600;">${waivePend} 🍴 lunch waive</span>`:''}${oos?` · <span style="color:#e07070;font-weight:600;">${oos} ⚠️ after submit</span>`:''}${still?` · <span style="color:var(--green);">${still} still in</span>`:''}`;
    const rows=records.map(l=>{
      const idx=timeLog.indexOf(l);
      const ph=paidHours(l);const hrs=ph!=null?ph.toFixed(2):'—';
      const outTxt=l.out?fmtDt(l.out):'<span style="color:var(--txt2)">Still in</span>';
      let actBadges=l.autoClocked?`<span class="badge b-auto">Auto-out ⚠️</span>`:(l.activity&&l.activity.length?l.activity.map(a=>`<span class="badge b-blue" style="margin-right:2px;">${a}</span>`).join(''):'—');
      if(l.manualEntry)actBadges=`<span class="badge" style="background:#f0a830;color:#3a2600;margin-right:2px;">✎ Manual</span>`+actBadges;
      // v42.0 lunch-waive status badge
      if(isPendingWaive(l))actBadges+=`<span class="badge" style="background:#fff2d6;color:#7a5200;margin-left:2px;">🍴 Waive pending</span>`;
      else if(l.lunchWaived===true)actBadges+=`<span class="badge" style="background:#d8f0d8;color:#1f5e1f;margin-left:2px;">🍴 Waived</span>`;
      else if(l.lunchWaiveRequested&&l.lunchWaived===false)actBadges+=`<span class="badge" style="background:#f0d8d8;color:#7a2020;margin-left:2px;">🍴 Waive denied</span>`;
      // v44.0: punch landed after the employee handed in their card (matched to that punch's own site)
      if(isOutOfSubmission(l,mySiteRows.find(r=>r.jobsite===l.jobsite)||null))actBadges+=`<span class="badge" style="background:#f7dede;color:#7a2020;margin-left:2px;">⚠️ After submit</span>`;
      const isAssignedSite=(activeSup.jobsites||[]).includes(l.jobsite);
      const siteColor=isAssignedSite?'b-blue':'b-amber'; // amber = unassigned/temp site
      return `<tr class="${l.autoClocked?'row-auto':''}">
        <td style="font-size:12px;color:var(--txt2);">${fmtDt(l.in)}</td>
        <td style="font-size:11px;"><span class="badge ${siteColor}" title="${isAssignedSite?'':'Temporary or unassigned site'}">${l.jobsite}</span></td>
        <td style="font-size:12px;">${outTxt}</td>
        <td style="font-size:12px;">${actBadges}</td>
        <td style="font-size:12px;font-weight:600;">${hrs}</td>
        <td><button class="btn-sm" onclick="openEditModal('db:${l.dbId||idx}')">Edit</button></td>
      </tr>`;
    }).join('');

    const cardId=`emp-card-${empId}`;
    return `<div class="emp-card" style="border-left:3px solid ${chip.border};">
      <div class="emp-card-header" onclick="toggleEmpCard('${cardId}')">
        <div>
          <p style="font-size:14px;font-weight:600;color:var(--txt);margin:0;">${data.name}
            <span class="badge" style="background:${chip.bg};color:${chip.color};margin-left:6px;font-size:10px;vertical-align:middle;">${chip.label}</span>
            ${forceBtn}${sendBtn}${sendBackBtn}
          </p>
          <p class="emp-summary">${summary}</p>
        </div>
        <span style="font-size:18px;color:var(--txt3);" id="${cardId}-chevron">▸</span>
      </div>
      <div class="emp-card-body" id="${cardId}">
        <div style="overflow-x:auto;">
          <table style="min-width:420px;">
            <thead><tr><th>Clock in</th><th>Jobsite</th><th>Clock out</th><th>Activity</th><th>Hrs</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
  }).join('');

  updateSubmitSummary(empMap,myStatusMap);
}

/* ─── Supervisor: site-wide submit to office (v44.0) ───────────────────────────
   Moves every employee currently at emp_submitted → sup_submitted for the viewed
   pay period, across the supervisor's assigned jobsites. 'open' employees (haven't
   handed in yet) are left untouched — stragglers stay for a later pass. This is what
   hard-locks those employees' My Timecard (the lock keys off stage ≥ sup_submitted). */

// Live count line under the submit button, based on the employees currently shown.
// statusMap here is already scoped to this supervisor's own jobsites (mySiteRows per employee).
function updateSubmitSummary(empMap,statusMap){
  const el=document.getElementById('s-submit-summary');
  if(!el)return;
  const ids=Object.keys(empMap||{});
  let submitted=0,open=0,sent=0;
  ids.forEach(id=>{
    const stage=minStage(statusMap[id]||[]);
    if(stageAtLeast(stage,TC_STAGE.SUP))sent++;
    else if(stage===TC_STAGE.EMP)submitted++;
    else open++;
  });
  const parts=[];
  if(submitted)parts.push(`<span style="color:var(--amber);font-weight:600;">${submitted} ready to send</span>`);
  if(sent)parts.push(`<span style="color:var(--green);font-weight:600;">${sent} already sent</span>`);
  if(open)parts.push(`<span style="color:var(--txt3);">${open} not submitted</span>`);
  el.innerHTML=ids.length?`Shown: ${parts.join(' · ')}`:'';
}

// The button click: authoritative period-scoped pass (independent of the display filter).
async function submitSiteToOffice(){
  if(!activeSup)return;
  const sites=activeSup.jobsites||[];
  if(!sites.length){showCustomAlert('No jobsites','You have no assigned jobsites to submit.');return;}
  const period=supStatusPeriod();
  const periodLabel=`${period.start.toLocaleDateString([],{month:'short',day:'numeric'})} – ${period.end.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;

  // Roster = every employee with a punch at this supervisor's sites in the viewed period.
  const {data:siteData,error:siteErr}=await sb.from('punches')
    .select('employee_id')
    .in('jobsite',sites)
    .gte('clock_in',period.start.toISOString())
    .lte('clock_in',period.end.toISOString());
  if(siteErr){showCustomAlert('Error','Could not load the roster: '+siteErr.message);return;}
  const empIds=[...new Set((siteData||[]).map(r=>r.employee_id).filter(Boolean))];
  if(!empIds.length){showCustomAlert('Nothing to submit',`No punches found at your jobsites for ${periodLabel}.`);return;}

  // v44.0 Build 3: statusMap is empId → array of site-rows. Scope to THIS supervisor's own
  // sites and work in (empId, jobsite) pairs — an employee can be ready at one of the
  // supervisor's sites and still open at another.
  const statusMap=await getAllStatusForPeriod(period.start);
  const readyPairs=[]; // {empId, jobsite}
  let alreadySent=0;
  empIds.forEach(id=>{
    const rows=(statusMap[id]||[]).filter(r=>sites.includes(r.jobsite));
    rows.forEach(r=>{
      if(r.stage===TC_STAGE.EMP)readyPairs.push({empId:id,jobsite:r.jobsite});
      else if(stageAtLeast(r.stage,TC_STAGE.SUP))alreadySent++;
    });
  });
  const openCount=empIds.filter(id=>{
    const rows=(statusMap[id]||[]).filter(r=>sites.includes(r.jobsite));
    return rows.length===0; // hasn't submitted at any of this supervisor's sites yet
  }).length;

  if(!readyPairs.length){
    showCustomAlert('No submitted timecards yet',
      `None of your employees have submitted their timecard for ${periodLabel} yet`+
      (openCount?`, so there's nothing to send. ${openCount} ${openCount!==1?'are':'is'} still open.`:'.')+
      (alreadySent?` (${alreadySent} already sent.)`:''));
    return;
  }

  const sub=openCount
    ? `${openCount} employee${openCount!==1?'s have':' has'} not submitted yet and will stay open for a later pass.`
    : 'All employees at your sites have submitted.';
  showCustomConfirm(
    `Submit ${readyPairs.length} timecard${readyPairs.length!==1?'s':''} to the office?`,
    `This sends the submitted timecards for ${periodLabel} to head office and locks them for those employees. This can't be undone from here.`,
    sub,
    `Submit ${readyPairs.length} to office`,'var(--green)',
    ()=>doSubmitSiteToOffice(readyPairs,period,periodLabel));
}

async function doSubmitSiteToOffice(readyPairs,period,periodLabel){
  const results=await Promise.all(readyPairs.map(p=>setTimecardStage(p.empId,period,TC_STAGE.SUP,p.jobsite)));
  const failed=results.filter(r=>!r.ok).length;
  if(failed){
    showCustomAlert('Some did not submit',
      `${readyPairs.length-failed} of ${readyPairs.length} submitted. ${failed} failed — check your connection and try again.`);
  } else {
    showNotif('✓','Site submitted',`${readyPairs.length} timecard${readyPairs.length!==1?'s':''} sent for ${periodLabel}`,'#2f7d31',2800);
  }
  refreshSupLog(); // repaint stage colours → submitted employees flip to "Sent to office"
}

/* ─── Supervisor: Send back to employee (v47.0) ────────────────────────────────
   Undoes the supervisor's "send to office" for this employee at the supervisor's own
   sites — resets sup_submitted → open so the employee can edit and re-submit.
   Only available until any site is exported; once exported, only the admin can act. */
async function supSendBackToEmployee(empId,empName){
  if(!activeSup)return;
  const sites=activeSup.jobsites||[];
  const period=supStatusPeriod();
  // Fresh status check — only retract sites at sup_submitted under this supervisor
  const statusMap=await getAllStatusForPeriod(period.start);
  const allRows=statusMap[empId]||[];
  // Block if any site is already exported
  if(allRows.some(r=>r.stage===TC_STAGE.EXPORTED)){
    showCustomAlert('Already exported','This employee\u2019s timecard has already been exported to head office. Only the GM/admin can send it back now.');
    refreshSupLog();
    return;
  }
  const retractable=allRows.filter(r=>sites.includes(r.jobsite)&&r.stage===TC_STAGE.SUP);
  if(!retractable.length){
    showCustomAlert('Nothing to send back',`${empName} has no timecards at your sites that are sent to office and eligible for return.`);
    refreshSupLog();
    return;
  }
  const siteList=retractable.map(r=>r.jobsite).sort().join(', ');
  showCustomConfirm(
    `Send ${empName}\u2019s timecard back?`,
    `This returns ${empName}\u2019s timecard at ${siteList} to them so they can make changes and re-submit. They\u2019ll need to submit again, then you\u2019ll need to re-send to office.`,
    '',
    'Send back','var(--amber)',
    async()=>{
      const results=await Promise.all(retractable.map(r=>setTimecardStage(empId,period,TC_STAGE.OPEN,r.jobsite)));
      const failed=results.filter(r=>!r.ok).length;
      if(failed){showCustomAlert('Problem','Some sites could not be sent back. Try again.');return;}
      showNotif('✓','Sent back',`${empName}\u2019s timecard returned at ${siteList}`,'#c47f17',2800);
      refreshSupLog();
    });
}

/* ─── Supervisor: Send one employee's timecard to office (v47.3) ────────────────────
   Per-employee counterpart to the batch "Send all Timecards to office" button. Reviews
   and sends this one employee's emp_submitted rows at THIS supervisor's sites to
   sup_submitted, so a supervisor can review + send one-by-one instead of firing the
   whole batch. Batch button (submitSiteToOffice) still works the same and picks up
   whoever's left at emp_submitted. */
async function supSendEmployeeToOffice(empId,empName){
  if(!activeSup)return;
  const sites=activeSup.jobsites||[];
  const period=supStatusPeriod();
  const periodLabel=`${period.start.toLocaleDateString([],{month:'short',day:'numeric'})} \u2013 ${period.end.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;
  const statusMap=await getAllStatusForPeriod(period.start);
  const allRows=statusMap[empId]||[];
  const sendable=allRows.filter(r=>sites.includes(r.jobsite)&&r.stage===TC_STAGE.EMP);
  if(!sendable.length){
    showCustomAlert('Nothing to send',`${empName} has no submitted timecards at your sites that are ready to send to office.`);
    refreshSupLog();
    return;
  }
  const siteList=sendable.map(r=>r.jobsite).sort().join(', ');
  showCustomConfirm(
    `Send ${empName}\u2019s timecard to office?`,
    `This sends ${empName}\u2019s submitted timecard at ${siteList} (${periodLabel}) to head office and locks it. Review their punches above before sending.`,
    'This can\u2019t be undone from here \u2014 you\u2019d need to use Send back if they need to make changes.',
    'Send to office','var(--green)',
    async()=>{
      const results=await Promise.all(sendable.map(r=>setTimecardStage(empId,period,TC_STAGE.SUP,r.jobsite)));
      const failed=results.filter(r=>!r.ok).length;
      if(failed){showCustomAlert('Problem',`Some sites could not be sent. ${sendable.length-failed} of ${sendable.length} succeeded.`);return;}
      showNotif('\u2713','Sent to office',`${empName}\u2019s timecard sent at ${siteList}`,'#2f7d31',2600);
      refreshSupLog();
    });
}

/* ─── Supervisor: Force Submit on an employee's behalf (v44.0 Build 3) ───────────────
   For an employee who can't/didn't submit themselves (away, forgot, etc.) — the supervisor
   reviews/corrects their punches, then force-submits for whichever of the supervisor's own
   sites that employee hasn't submitted yet (open → emp_submitted). Blocked by unresolved
   auto-clocks / pending lunch waives, same gate as everywhere else in the app. No audit
   marker is kept — once forced, it's indistinguishable from a normal employee submission. */
async function forceSubmitEmployee(empId,empName){
  if(!activeSup)return;
  const sites=activeSup.jobsites||[];
  const period=supStatusPeriod();
  const periodLabel=`${period.start.toLocaleDateString([],{month:'short',day:'numeric'})} – ${period.end.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;

  // Fresh punches for this employee at the supervisor's sites, within the status period.
  const {data,error}=await sb.from('punches').select('*')
    .eq('employee_id',empId).in('jobsite',sites)
    .gte('clock_in',period.start.toISOString()).lte('clock_in',period.end.toISOString());
  if(error){showCustomAlert('Error','Could not load punches: '+error.message);return;}
  const punches=(data||[]).map(dbRowToEntry);
  if(!punches.length){showCustomAlert('Nothing to submit',`${empName} has no punches at your sites for ${periodLabel}.`);return;}

  // Which of the supervisor's sites does this employee have punches at but no valid submission?
  // v47.2: matches the button-visibility filter in the supervisor card (widened v44.2 there,
  // but this action-side filter was never updated — button appeared, click failed with
  // "already submitted" even when the row was legitimately at 'open' after a pull-back or
  // an admin send-back).
  const rows=await getEmployeeStatusRows(empId,period.start);
  const rowsBySite={};rows.forEach(r=>{rowsBySite[r.jobsite]=r;});
  const openSites=[...new Set(punches.map(p=>p.jobsite))].filter(s=>sites.includes(s)&&(!rowsBySite[s]||rowsBySite[s].stage===TC_STAGE.OPEN));
  if(!openSites.length){showCustomAlert('Already submitted',`${empName} has already submitted for your site(s) this period.`);return;}

  // Gate: unresolved auto-clocks / pending waives among punches at the sites being forced.
  const relevant=punches.filter(p=>openSites.includes(p.jobsite));
  const autos=relevant.filter(p=>p.autoClocked&&!p.editedAfterAuto);
  const waives=relevant.filter(p=>isPendingWaive(p));
  if(autos.length||waives.length){
    const parts=[];
    if(autos.length)parts.push(`${autos.length} unresolved auto-clock-out${autos.length!==1?'s':''}`);
    if(waives.length)parts.push(`${waives.length} pending lunch waive${waives.length!==1?'s':''}`);
    showCustomAlert('Fix these first',`${empName} has ${parts.join(' and ')} at ${openSites.join(', ')}. Resolve via Edit before force-submitting.`);
    return;
  }

  showCustomConfirm(
    `Force submit for ${empName}?`,
    `This submits ${empName}'s timecard for ${openSites.join(', ')} (${periodLabel}) on their behalf, as if they'd submitted it themselves. Review their punches above before doing this.`,
    'They can still be included in your next "Submit site to office" pass.',
    'Force submit','var(--amber)',
    async()=>{
      const results=await Promise.all(openSites.map(js=>setTimecardStage(empId,period,TC_STAGE.EMP,js)));
      const failed=results.filter(r=>!r.ok);
      if(failed.length){showCustomAlert('Could not submit','There was a problem: '+(failed[0].error?.message||'unknown error'));return;}
      showNotif('✓','Force submitted',`${empName}'s timecard is ready to send`,'#c47f17',2600);
      refreshSupLog();
    });
}

/* ─── Navigate from Live tiles to the Time log with the right view ─── */
function goToSupReport(which){
  switchSupTab('log');
  const ff=document.getElementById('s-filter-flags');
  if(which==='headcount'){
    setSupPeriod('today');
    if(ff)ff.value='stillin';
    refreshSupLog();
  } else if(which==='yesterday'){
    setSupPeriod('yesterday');
    if(ff)ff.value='';
    refreshSupLog();
  } else if(which==='review'){
    if(ff)ff.value='review';
    refreshSupLog();
  }
}

function toggleEmpCard(id){
  const body=document.getElementById(id);
  const chev=document.getElementById(id+'-chevron');
  if(!body)return;
  const open=body.classList.toggle('open');
  if(chev)chev.textContent=open?'▾':'▸';
}

/* ─── Master: Settings (pay rules, v36.1) ─── */
function refreshSettingsPanel(){
  document.getElementById('set-rounding-enabled').checked=APP_SETTINGS.roundingEnabled;
  document.getElementById('set-rounding-minutes').value=String(APP_SETTINGS.roundingMinutes||15);
  document.getElementById('set-sched-enabled').checked=APP_SETTINGS.schedEndEnabled;
  document.getElementById('set-sched-time').value=APP_SETTINGS.schedEndTime||'15:30';
  document.getElementById('set-sched-window').value=APP_SETTINGS.schedEndWindow||15;
  document.getElementById('set-lunch-enabled').checked=APP_SETTINGS.lunchEnabled;
  document.getElementById('set-lunch-minutes').value=String(APP_SETTINGS.lunchMinutes||30);
  document.getElementById('set-lunch-threshold').value=String(APP_SETTINGS.lunchThresholdHours||5);
  document.getElementById('set-save-msg').textContent='';
}
async function saveSettings(){
  const msg=document.getElementById('set-save-msg');
  const roundingMinutes=parseInt(document.getElementById('set-rounding-minutes').value,10)||15;
  const schedTime=document.getElementById('set-sched-time').value||'15:30';
  let schedWindow=parseInt(document.getElementById('set-sched-window').value,10);
  if(isNaN(schedWindow)||schedWindow<1)schedWindow=15;
  let lunchMinutes=parseInt(document.getElementById('set-lunch-minutes').value,10);
  if(isNaN(lunchMinutes)||lunchMinutes<0)lunchMinutes=30;
  let lunchThreshold=parseFloat(document.getElementById('set-lunch-threshold').value);
  if(isNaN(lunchThreshold)||lunchThreshold<0)lunchThreshold=5;
  const row={
    id:1,
    rounding_enabled:document.getElementById('set-rounding-enabled').checked,
    rounding_minutes:roundingMinutes,
    sched_end_enabled:document.getElementById('set-sched-enabled').checked,
    sched_end_time:schedTime,
    sched_end_window:schedWindow,
    lunch_enabled:document.getElementById('set-lunch-enabled').checked,
    lunch_minutes:lunchMinutes,
    lunch_threshold_hours:lunchThreshold,
    updated_at:new Date().toISOString()
  };
  msg.style.color='var(--txt2)';msg.textContent='Saving…';
  const {error}=await sb.from('pt_settings').upsert(row,{onConflict:'id'});
  if(error){msg.style.color='var(--red)';msg.textContent='Could not save: '+error.message;return}
  applySettingsRow(row);            // update this device immediately
  msg.style.color='var(--green)';msg.textContent='Saved. Pay rules updated across all devices.';
}

/* ─── Supervisor: Employees ─── */
function refreshSupEmps(){
  // v43.0: accordion (Name + PIN in header, rest in body); active employees only.
  const container=document.getElementById('s-emp-accordion');
  const myId=activeSup&&activeSup.id;
  const actives=employees.filter(e=>e.active);
  if(!actives.length){container.innerHTML='<p style="color:var(--txt2);text-align:center;padding:24px 0;font-size:13px;">No active employees</p>';return}
  container.innerHTML=actives.map(e=>{
    const isOtherSup=e.dept==='Supervisor'&&e.id!==myId;
    const cardId=`s-emp-card-${e.id}`;
    return `<div class="emp-card">
      <div class="emp-card-header" onclick="toggleEmpCard('${cardId}')">
        <div>
          <p style="font-size:14px;font-weight:600;color:var(--txt);margin:0;">${e.name}</p>
          <p class="emp-summary">PIN: <code style="font-size:12px;">${e.pin}</code></p>
        </div>
        <span style="font-size:18px;color:var(--txt3);" id="${cardId}-chevron">▸</span>
      </div>
      <div class="emp-card-body" id="${cardId}">
        <div style="padding:12px 14px;">
          <p style="font-size:13px;color:var(--txt2);margin:0 0 10px;">Dept: <span style="color:var(--txt);">${e.dept}</span></p>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn-sm" onclick="openEmpModal(${e.id},'sup')">Edit</button>
            ${isOtherSup?'':`<button class="btn-sm" onclick="openPinResetModal(${e.id})">Reset PIN</button>`}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

/* ─── PIN Reset modal ─── */
let pinResetEmpId=null;
function openPinResetModal(empId){
  pinResetEmpId=empId;
  const emp=employees.find(e=>e.id===empId);
  if(!emp)return;
  document.getElementById('pin-reset-emp-name').value=emp.name;
  document.getElementById('pin-reset-new').value='';
  document.getElementById('pin-reset-err').textContent='';
  document.getElementById('pin-reset-modal-bg').style.display='flex';
}
function closePinResetModal(){
  document.getElementById('pin-reset-modal-bg').style.display='none';
  pinResetEmpId=null;
}
async function savePinReset(){
  const newPin=document.getElementById('pin-reset-new').value.trim();
  const err=document.getElementById('pin-reset-err');
  if(!/^\d{4,6}$/.test(newPin)){err.textContent='PIN must be 4–6 digits.';return}
  const dup=employees.find(e=>e.pin===newPin&&e.id!==pinResetEmpId);
  if(dup){err.textContent='That PIN is already used by '+dup.name+'.';return}
  const emp=employees.find(e=>e.id===pinResetEmpId);
  if(!emp)return;
  const {error}=await sb.from('employees').update({pin:newPin}).eq('id',pinResetEmpId);
  if(error){err.textContent='DB error: '+error.message;return}
  emp.pin=newPin;
  closePinResetModal();
  refreshSupEmps();
  showNotif('✓','PIN updated',emp.name+' can now use their new PIN','#1D9E75');
}

/* ─── Master tabs ─── */
const MASTER_TAB_GROUP={
  overview:'overview',
  jobsites:'manage', employees:'manage', departments:'manage', activities:'manage',
  submissions:'reporting', log:'reporting',
  settings:'settings'
};
const MASTER_GROUP_DEFAULT={manage:'employees', reporting:'log'};

// Top-level group tab handler (v38.0): jumps to the group's default child tab.
function switchMasterGroup(group){
  switchMasterTab(MASTER_GROUP_DEFAULT[group]||group);
}

function switchMasterTab(tab){
  // Show only the selected panel (panel ids unchanged from the flat-nav version).
  ['overview','jobsites','employees','departments','activities','submissions','log','settings'].forEach(t=>{
    const p=document.getElementById('mpanel-'+t);
    if(p)p.style.display=t===tab?'block':'none';
  });
  // Resolve which top-level group this tab belongs to (v38.0 grouped nav).
  const group=MASTER_TAB_GROUP[tab]||tab;
  // Top-level active state: highlight the parent group.
  ['overview','manage','reporting','settings'].forEach(g=>{
    const btn=document.getElementById('mtab-'+g);
    if(btn)btn.classList.toggle('active',g===group);
  });
  // Sub-nav rows: only the active group's row is shown.
  ['manage','reporting'].forEach(g=>{
    const row=document.getElementById('msub-'+g);
    if(row)row.style.display=g===group?'flex':'none';
  });
  // Sub-nav button active state.
  document.querySelectorAll('.msub-btn').forEach(b=>{
    b.classList.toggle('active',b.dataset.tab===tab);
  });
  if(tab==='overview')refreshMasterOverview();
  if(tab==='jobsites'){refreshJobsitePanel();refreshNewJobsiteSupChecks();}
  if(tab==='employees')refreshMasterEmps();
  if(tab==='departments')refreshDepartmentsPanel();
  if(tab==='activities')refreshActivitiesPanel();
  if(tab==='submissions')setSubPeriod(_subPeriodMode||'current'); // v44.0 Build 3: also paints the period-button active state
  if(tab==='settings')refreshSettingsPanel();
  if(tab==='log'){
    populateMasterFilters();
    // Reset all filters to defaults whenever the tab is opened directly
    document.getElementById('m-filter-site').value='';
    document.getElementById('m-filter-emp').value='';
    document.getElementById('m-filter-flags').value='';
    initMasterLogDates();
  }
}

/* ─── Master: Activities panel ─── */
let _editingActivityId=null;

function refreshActivitiesPanel(){
  const list=document.getElementById('activities-list');
  document.getElementById('activity-add-err').textContent='';
  if(!ALL_ACTIVITIES.length){
    list.innerHTML='<p style="color:var(--txt2);font-size:13px;text-align:center;padding:20px 0;">No activities yet — add one below.</p>';
    return;
  }
  // v43.0: activities listed alphabetically (was sort_order); ↑/↓ reorder removed.
  const sorted=[...ALL_ACTIVITIES].sort((a,b)=>a.name.localeCompare(b.name));
  list.innerHTML=sorted.map(a=>{
    const isActive=a.active;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border:0.5px solid var(--bdr);border-radius:var(--radius);margin-bottom:7px;background:${isActive?'var(--bg2)':'var(--bg)'};opacity:${isActive?'1':'0.55'};">
      <div style="display:flex;align-items:center;gap:10px;">
        <div>
          <p style="font-size:13px;font-weight:500;color:${isActive?'var(--txt)':'var(--txt2)'};margin:0;">${a.name}</p>
          <p style="font-size:10px;color:var(--txt3);margin:0;">${a.code?'Code: '+a.code:'No code'}${isActive?'':' · Inactive'}</p>
        </div>
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;">
        <button class="btn-sm" onclick="openEditActivityModal(${a.id})">Edit</button>
        ${isActive?`
        <button class="btn-sm danger" onclick="toggleActivityActive(${a.id},false,'${a.name.replace(/'/g,"\'")}')">Deactivate</button>
        `:`<button class="btn-sm primary" onclick="toggleActivityActive(${a.id},true,'${a.name.replace(/'/g,"\'")}')">Activate</button>`}
      </div>
    </div>`;
  }).join('');
}

async function addActivity(){
  const inp=document.getElementById('new-activity-name');
  const err=document.getElementById('activity-add-err');
  const name=inp.value.trim();
  if(!name){err.textContent='Please enter an activity name.';return}
  if(ACTIVITIES.find(a=>a.name.toLowerCase()===name.toLowerCase())){err.textContent='An activity with that name already exists.';return}
  const sortOrder=ACTIVITIES.length+1;
  const {data,error}=await sb.from('activities').insert({name,active:true,sort_order:sortOrder}).select().single();
  if(error){err.textContent='DB error: '+error.message;return}
  const newAct={id:data.id,name:data.name,code:data.code||'',sortOrder:data.sort_order,active:true};
  ALL_ACTIVITIES.push(newAct);ACTIVITIES.push(newAct);
  inp.value='';err.textContent='';
  refreshActivitiesPanel();
}

function openEditActivityModal(id){
  _editingActivityId=id;
  const act=ALL_ACTIVITIES.find(a=>a.id===id);
  if(!act)return;
  document.getElementById('edit-activity-old').textContent=act.name;
  document.getElementById('edit-activity-new').value=act.name;
  document.getElementById('edit-activity-code').value=act.code||'';
  document.getElementById('edit-activity-err').textContent='';
  document.getElementById('edit-activity-modal-bg').style.display='flex';
  setTimeout(()=>{
    const inp=document.getElementById('edit-activity-new');
    inp.focus();inp.select();
  },80);
}

function closeEditActivityModal(){
  document.getElementById('edit-activity-modal-bg').style.display='none';
  _editingActivityId=null;
}

function confirmDeleteActivity(){
  const act=ALL_ACTIVITIES.find(a=>a.id===_editingActivityId);
  if(!act)return;
  const usedInLog=false; // historical records kept regardless
  showCustomConfirm(
    `Delete "${act.name}"?`,
    'This will permanently remove this activity from the database.',
    'Historical punch records that referenced this activity will still show the name — only the activity option itself is deleted.',
    'Delete permanently',
    'var(--red)',
    async()=>{
      const {error}=await sb.from('activities').delete().eq('id',_editingActivityId);
      if(error){showCustomAlert('Error','Could not delete: '+error.message);return}
      ALL_ACTIVITIES=ALL_ACTIVITIES.filter(a=>a.id!==_editingActivityId);
      ACTIVITIES=ALL_ACTIVITIES.filter(a=>a.active);
      closeEditActivityModal();
      refreshActivitiesPanel();
      showNotif('✓',`"${act.name}" deleted`,'Activity permanently removed','#c47f17',2400);
    }
  );
}

async function saveActivityEdit(){
  const newName=document.getElementById('edit-activity-new').value.trim();
  const newCode=document.getElementById('edit-activity-code').value.trim();
  const err=document.getElementById('edit-activity-err');
  if(!newName){err.textContent='Please enter a name.';return}
  const act=ALL_ACTIVITIES.find(a=>a.id===_editingActivityId);
  if(!act)return;
  if(newName===act.name&&newCode===(act.code||'')){closeEditActivityModal();return}
  if(ALL_ACTIVITIES.find(a=>a.name.toLowerCase()===newName.toLowerCase()&&a.id!==_editingActivityId)){
    err.textContent='An activity with that name already exists.';return
  }
  const {error}=await sb.from('activities').update({name:newName,code:newCode||null}).eq('id',_editingActivityId);
  if(error){err.textContent='DB error: '+error.message;return}
  act.name=newName;act.code=newCode;
  const activeAct=ACTIVITIES.find(a=>a.id===_editingActivityId);
  if(activeAct){activeAct.name=newName;activeAct.code=newCode;}
  closeEditActivityModal();
  refreshActivitiesPanel();
  showNotif('✓','Activity updated',`"${newName}" saved`,'#2d7a2d',2000);
}

async function moveActivity(id,dir){
  const activeOnes=ALL_ACTIVITIES.filter(a=>a.active);
  const idx=activeOnes.findIndex(a=>a.id===id);
  const newIdx=idx+dir;
  if(newIdx<0||newIdx>=activeOnes.length)return;
  [activeOnes[idx],activeOnes[newIdx]]=[activeOnes[newIdx],activeOnes[idx]];
  // Rebuild ALL_ACTIVITIES with new sort order for active items
  let activeCounter=0;
  ALL_ACTIVITIES.forEach(a=>{
    if(a.active){a.sortOrder=activeOnes[activeCounter].sortOrder;activeCounter++;}
  });
  // Re-sort ALL_ACTIVITIES
  ALL_ACTIVITIES.sort((a,b)=>a.sortOrder-b.sortOrder);
  ACTIVITIES=ALL_ACTIVITIES.filter(a=>a.active);
  const updates=activeOnes.map((a,i)=>
    sb.from('activities').update({sort_order:i+1}).eq('id',a.id)
  );
  await Promise.all(updates);
  refreshActivitiesPanel();
}

async function toggleActivityActive(id,activate,name){
  const verb=activate?'Activate':'Deactivate';
  const sub=activate?'Employees will be able to select this activity when clocking out.':'Employees will no longer see this activity. Historical records are preserved.';
  showCustomConfirm(
    `${verb} "${name}"?`,sub,'',verb,
    activate?'var(--green)':'var(--amber)',
    async()=>{
      const {error}=await sb.from('activities').update({active:activate}).eq('id',id);
      if(error){showCustomAlert('Error','Could not update: '+error.message);return}
      const a=ALL_ACTIVITIES.find(a=>a.id===id);
      if(a)a.active=activate;
      ACTIVITIES=ALL_ACTIVITIES.filter(a=>a.active);
      refreshActivitiesPanel();
      showNotif('✓',`"${name}" ${activate?'activated':'deactivated'}`,
        activate?'Now visible on clock-out screen':'Hidden from clock-out screen',
        activate?'#2d7a2d':'#c47f17',2200);
    }
  );
}

/* ─── Master: Overview ─── */
let _overviewReadyPrefPeriod='current'; // v47.5: 'current' | 'last' — set by refreshMasterOverview, consumed by goToReadyExports()
async function refreshMasterOverview(){
  await checkAutoServer();
  document.getElementById('m-stat-in').textContent=timeLog.filter(l=>!l.out).length;
  document.getElementById('m-stat-emps').textContent=employees.filter(e=>e.active).length;

  // v47.3: current-period boundaries drive both the Needs Review tile and the Ready-to-Export tile.
  const period=getPeriodByOffset(0);

  // v47.3: Needs Review — scoped to the current pay period only. Prior periods should already be
  // resolved (via admin correction / override / send-back flows) so counting them as still-flagged
  // was noisy and misleading — the number never dropped to zero even when nothing current was flagged.
  const {count:flagCount}=await sb.from('punches')
    .select('*',{count:'exact',head:true})
    .eq('auto_clocked',true)
    .eq('edited_after_auto',false)
    .gte('clock_in',period.start.toISOString())
    .lte('clock_in',period.end.toISOString());
  document.getElementById('m-stat-flags').textContent=flagCount||0;

  // v47.5: Timecards Ready to Export — now spans current period + last period (not current-only).
  // Originally current-period-only (v47.3), but that reads 0 on the morning right after a period
  // rolls over, which is exactly when payroll processing actually happens (the day after period
  // end) — so the tile looked "empty" right when it mattered most. Count = employees whose EVERY
  // worked site in that period is at sup_submitted (fully ready) and nothing yet exported, summed
  // across both periods. Also sets _overviewReadyPrefPeriod so the tile's click-through lands on
  // whichever period actually has something in it, instead of always opening on 'current' and
  // showing an empty list when the ready employees are all sitting in 'last'. Live-ness comes from
  // refreshMasterOverview being called on overview tab switch (switchMasterTab in the 'overview'
  // branch below), so returning to the tile always shows current state — no realtime subscription
  // needed.
  const [readyCurrent,readyLast]=await Promise.all([
    computeReadyCountForPeriod(period),
    computeReadyCountForPeriod(getPeriodByOffset(1))
  ]);
  document.getElementById('m-stat-ready').textContent=readyCurrent+readyLast;
  _overviewReadyPrefPeriod=(readyCurrent===0&&readyLast>0)?'last':'current';
  const div=document.getElementById('m-site-overview');
  div.innerHTML=JOBSITES.map((site,si)=>{
    const color=getSiteColor(si);
    const inNow=timeLog.filter(l=>l.jobsite===site&&!l.out).length;
    const siteSups=supervisors.filter(s=>(s.jobsites||[]).includes(site));
    const supLabel=siteSups.length?siteSups.map(s=>s.name).join(', '):'No supervisor assigned';
    const safesite=site.replace(/'/g,"\\'");
    return `<div onclick="goToReport({today:true,site:'${safesite}'})" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:0.5px solid var(--bdr);border-radius:var(--radius);margin-bottom:7px;background:var(--bg);cursor:pointer;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="site-stripe" style="background:${color};width:10px;height:10px;"></span>
        <div><p style="font-size:14px;font-weight:600;color:var(--txt);margin:0;">${site}</p><p style="font-size:11px;color:var(--txt2);margin:0;">${supLabel}</p></div>
      </div>
      <div style="text-align:right;"><p style="font-size:20px;font-weight:600;color:var(--txt);margin:0;">${inNow}</p><p style="font-size:10px;color:var(--txt2);margin:0;">clocked in</p></div>
    </div>`;
  }).join('');
}

/* ─── Departments panel ─── */
function refreshDepartmentsPanel(){
  const list=document.getElementById('dept-list');
  document.getElementById('dept-add-err').textContent='';
  if(!DEPARTMENTS.length){
    list.innerHTML='<p style="color:var(--txt2);font-size:13px;padding:20px 0;text-align:center;">No departments found.</p>';
    return;
  }
  list.innerHTML=DEPARTMENTS.map(d=>{
    const isProtected=d.protected;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border:0.5px solid var(--bdr);border-radius:var(--radius);margin-bottom:7px;background:${d.active?'var(--bg2)':'var(--bg)'};opacity:${d.active?'1':'0.55'};">
      <div>
        <p style="font-size:13px;font-weight:500;color:var(--txt);margin:0;">${d.name}${isProtected?' <span style="font-size:10px;color:var(--txt3);">(protected)</span>':''}</p>
        ${!d.active?'<p style="font-size:10px;color:var(--txt3);margin:0;">Inactive</p>':''}
      </div>
      <div style="display:flex;gap:5px;">
        ${!isProtected&&d.active?`<button class="btn-sm danger" onclick="confirmDeactivateDept(${d.id},'${d.name.replace(/'/g,"\'")}')">Deactivate</button>`:''}
        ${!isProtected&&!d.active?`<button class="btn-sm primary" onclick="reactivateDept(${d.id},'${d.name.replace(/'/g,"\'")}')">Activate</button>`:''}
      </div>
    </div>`;
  }).join('');
}

async function addDepartment(){
  const inp=document.getElementById('new-dept-name');
  const err=document.getElementById('dept-add-err');
  const name=inp.value.trim();
  if(!name){err.textContent='Please enter a name.';return}
  if(DEPARTMENTS.find(d=>d.name.toLowerCase()===name.toLowerCase())){err.textContent='A department with that name already exists.';return}
  const sortOrder=DEPARTMENTS.length+1;
  const {data,error}=await sb.from('departments').insert({name,protected:false,active:true,sort_order:sortOrder}).select().single();
  if(error){err.textContent='DB error: '+error.message;return}
  DEPARTMENTS.push({id:data.id,name:data.name,protected:false,active:true,sortOrder:data.sort_order});
  inp.value='';err.textContent='';
  refreshDepartmentsPanel();rebuildDeptDropdown();
  showNotif('✓',`"${name}" added`,'Department available in employee form','#2d7a2d',2000);
}

function confirmDeactivateDept(id,name){
  showCustomConfirm(`Deactivate "${name}"?`,
    'This department will be hidden from the employee form.',
    'Existing employees in this department are not affected.',
    'Deactivate','var(--amber)',
    async()=>{
      const {error}=await sb.from('departments').update({active:false}).eq('id',id);
      if(error){showCustomAlert('Error',error.message);return}
      const d=DEPARTMENTS.find(d=>d.id===id);if(d)d.active=false;
      refreshDepartmentsPanel();rebuildDeptDropdown();
    }
  );
}

async function reactivateDept(id,name){
  const {error}=await sb.from('departments').update({active:true}).eq('id',id);
  if(error){showCustomAlert('Error',error.message);return}
  const d=DEPARTMENTS.find(d=>d.id===id);if(d)d.active=true;
  refreshDepartmentsPanel();rebuildDeptDropdown();
  showNotif('✓',`"${name}" activated`,'Now available in employee form','#2d7a2d',2000);
}

function rebuildDeptDropdown(){
  const sel=document.getElementById('emp-dept-inp');
  if(!sel)return;
  const cur=sel.value;
  sel.innerHTML='<option value="">Select department…</option>'+
    DEPARTMENTS.filter(d=>d.active).map(d=>`<option value="${d.name}"${d.name===cur?' selected':''}>${d.name}</option>`).join('');
}

/* ─── Master: Employees ─── */
function refreshMasterEmps(){
  // v43.0: accordion (Name + PIN in header, rest in body). Active employees shown first;
  // removed (active=false) employees shown greyed-out below with an Activate button.
  const container=document.getElementById('m-emp-accordion');
  const renderCard=(e)=>{
    const isSup=e.dept==='Supervisor';
    const sites=(e.supervisorJobsites||[]).map(j=>`<span class="badge b-blue" style="font-size:10px;">${j}</span>`).join(' ');
    const cardId=`m-emp-card-${e.id}`;
    return `<div class="emp-card" style="${e.active?'':'opacity:.55;'}">
      <div class="emp-card-header" onclick="toggleEmpCard('${cardId}')">
        <div>
          <p style="font-size:14px;font-weight:600;color:var(--txt);margin:0;">${e.name}${isSup?'<span class="badge b-amber" style="font-size:10px;margin-left:4px;">SUP</span>':''}${!e.active?'<span style="font-size:10px;color:var(--txt3);margin-left:4px;">(removed)</span>':''}</p>
          <p class="emp-summary">PIN: <code style="font-size:12px;">${e.pin}</code></p>
        </div>
        <span style="font-size:18px;color:var(--txt3);" id="${cardId}-chevron">▸</span>
      </div>
      <div class="emp-card-body" id="${cardId}">
        <div style="padding:12px 14px;">
          <p style="font-size:13px;color:var(--txt2);margin:0 0 8px;">Dept: <span style="color:var(--txt);">${e.dept}</span></p>
          ${isSup?`<p style="font-size:13px;color:var(--txt2);margin:0 0 10px;">Assigned jobsites: ${sites||'<span style="color:var(--txt3);">None</span>'}</p>`:''}
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn-sm" onclick="openEmpModal(${e.id},'master')">Edit</button>
            <button class="btn-sm ${e.active?'danger':'primary'}" onclick="toggleEmpActive(${e.id})">${e.active?'Remove':'Activate'}</button>
          </div>
        </div>
      </div>
    </div>`;
  };
  const actives=employees.filter(e=>e.active);
  const removed=employees.filter(e=>!e.active);
  let html=actives.map(renderCard).join('');
  if(removed.length){
    html+=`<p style="font-size:11px;color:var(--txt3);margin:18px 0 8px;text-transform:uppercase;letter-spacing:.4px;">Removed employees</p>`+removed.map(renderCard).join('');
  }
  container.innerHTML=html||'<p style="color:var(--txt2);text-align:center;padding:24px 0;font-size:13px;">No employees yet</p>';
}

/* ─── Master: Report ─── */
/* ─── Navigate from overview tiles to Report tab with pre-set filters ─── */
function goToReport({today=false, flags=false, site=''}={}){
  switchMasterTab('log');
  // switchMasterTab already resets all dropdowns and calls initMasterLogDates (current period).
  // Now override only what this specific tile needs.
  if(flags){
    // Needs Review tile: current period range, flags filter on
    const pp=getPeriodByOffset(0);
    document.getElementById('m-log-from').value=toDateStr(pp.start);
    document.getElementById('m-log-to').value=toDateStr(pp.end);
    // Highlight 'current' period button to match date range shown
    ['today','yesterday','current','last','prev2'].forEach(m=>{
      const btn=document.getElementById('mpbtn-'+m);
      if(btn){btn.style.fontWeight=m==='current'?'700':'500';btn.style.background=m==='current'?'var(--blue-l)':'';btn.style.color=m==='current'?'var(--blue-d)':'';}
    });
    document.getElementById('m-filter-flags').value='auto';
  } else if(today||site){
    // Clocked In Now tile or site card: today date range, highlight Today button
    setMasterPeriod('today');
    if(site)document.getElementById('m-filter-site').value=site;
  }
  refreshMasterLog();
}

function populateMasterFilters(){
  refreshAllJobsiteDropdowns();
  const me=document.getElementById('m-filter-emp');
  if(me)me.innerHTML='<option value="">All employees</option>'+employees.map(e=>`<option value="${e.id}">${e.name}</option>`).join('');
}
let _masterPeriodMode='current';
function initMasterLogDates(){
  setMasterPeriod('current');
}
function setMasterPeriod(mode){
  _masterPeriodMode=mode;
  ['today','yesterday','current','last','prev2'].forEach(m=>{
    const btn=document.getElementById('mpbtn-'+m);
    if(btn){btn.style.fontWeight=m===mode?'700':'500';btn.style.background=m===mode?'var(--blue-l)':'';btn.style.color=m===mode?'var(--blue-d)':'';}
  });
  const now=new Date();
  let from,to;
  if(mode==='today'){
    from=new Date(now);from.setHours(0,0,0,0);
    to=new Date(now);to.setHours(23,59,59,999);
  } else if(mode==='yesterday'){
    const y=new Date(now);y.setDate(y.getDate()-1);
    from=new Date(y);from.setHours(0,0,0,0);
    to=new Date(y);to.setHours(23,59,59,999);
  } else if(mode==='current'){
    const p=getPeriodByOffset(0);from=p.start;to=p.end;
  } else if(mode==='last'){
    const p=getPeriodByOffset(1);from=p.start;to=p.end;
  } else if(mode==='prev2'){
    const p=getPeriodByOffset(2);from=p.start;to=p.end;
  }
  document.getElementById('m-log-from').value=toDateStr(from);
  document.getElementById('m-log-to').value=toDateStr(to);
  refreshMasterLog();
}
let _masterLogs=[]; // cached result of last DB query
let _masterLogSeq=0; // v40.1: race guard — only the most recently-initiated call may render
async function getMasterLogFiltered(){
  const fromV=document.getElementById('m-log-from').value;
  const toV=document.getElementById('m-log-to').value;
  const siteF=document.getElementById('m-filter-site').value;
  const empF=document.getElementById('m-filter-emp').value;
  const flagF=document.getElementById('m-filter-flags').value;
  let from=null,to=null;
  if(fromV){const[fy,fm,fd]=fromV.split('-').map(Number);from=new Date(fy,fm-1,fd,0,0,0,0);}
  if(toV){const[ty,tm,td]=toV.split('-').map(Number);to=new Date(ty,tm-1,td,23,59,59,999);}
  let query=sb.from('punches').select('*').order('clock_in',{ascending:false});
  if(from)query=query.gte('clock_in',from.toISOString());
  if(to)query=query.lte('clock_in',to.toISOString());
  if(siteF)query=query.eq('jobsite',siteF);
  if(empF)query=query.eq('employee_id',empF);
  if(flagF==='auto')query=query.eq('auto_clocked',true);
  const {data,error}=await query;
  if(error){showCustomAlert('Error','Could not load report: '+error.message);return [];}
  return (data||[]).map(dbRowToEntry);
}
async function refreshMasterLog(){
  const _mySeq=++_masterLogSeq;
  await checkAutoServer();
  const logs=await getMasterLogFiltered();
  if(_mySeq!==_masterLogSeq)return; // a newer call has superseded this one — drop the stale render
  _masterLogs=logs;
  // Update preview summary
  const prev=document.getElementById('m-report-preview');
  if(logs.length){
    const totalHrs=logs.reduce((s,l)=>s+(paidHours(l)||0),0);
    const empCount=new Set(logs.map(l=>l.empId)).size;
    const flags=logs.filter(l=>l.autoClocked).length;
    prev.innerHTML=`<strong>${logs.length}</strong> records &nbsp;·&nbsp; <strong>${empCount}</strong> employee${empCount!==1?'s':''} &nbsp;·&nbsp; <strong>${totalHrs.toFixed(1)}h</strong> total${flags?` &nbsp;·&nbsp; <strong style="color:#e07070;">${flags} ⚠️ need review</strong>`:''}`;
  } else {
    prev.textContent='No records match the selected filters.';
  }
  const tbody=document.getElementById('m-log-table');
  if(!logs.length){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;color:var(--txt2);padding:20px;">No records match</td></tr>';return}
  tbody.innerHTML=[...logs].reverse().map(l=>{
    const idx=timeLog.indexOf(l);
    const ph=paidHours(l);const hrs=ph!=null?ph.toFixed(2):'—';
    const outTxt=l.out?fmtDt(l.out):'<span style="color:var(--txt2)">Still in</span>';
    let actBadges=l.autoClocked?`<span class="badge b-auto">Auto-out ⚠️</span>`:(l.activity&&l.activity.length?l.activity.map(a=>`<span class="badge b-blue" style="margin-right:2px;">${a}</span>`).join(''):'—');
    if(l.manualEntry)actBadges=`<span class="badge" style="background:#f0a830;color:#3a2600;margin-right:2px;">✎ Manual</span>`+actBadges;
    if(isPendingWaive(l))actBadges+=`<span class="badge" style="background:#fff2d6;color:#7a5200;margin-left:2px;">🍴 Waive pending</span>`;
    else if(l.lunchWaived===true)actBadges+=`<span class="badge" style="background:#d8f0d8;color:#1f5e1f;margin-left:2px;">🍴 Waived</span>`;
    else if(l.lunchWaiveRequested&&l.lunchWaived===false)actBadges+=`<span class="badge" style="background:#f0d8d8;color:#7a2020;margin-left:2px;">🍴 Waive denied</span>`;
    const si=JOBSITES.indexOf(l.jobsite);const color=si>=0?getSiteColor(si):'#555';
    return `<tr class="${l.autoClocked?'row-auto':''}">
      <td>${l.name}${l.autoClocked?' ⚠️':''}</td>
      <td><span style="display:inline-flex;align-items:center;gap:4px;"><span class="site-stripe" style="background:${color}"></span>${l.jobsite||'—'}</span></td>
      <td style="font-size:12px;">${fmtDt(l.in)}</td>
      <td style="font-size:12px;">${outTxt}</td>
      <td style="font-size:11px;">${actBadges}</td>
      <td style="font-weight:600;">${hrs}</td>
      <td><button class="btn-sm" onclick="openEditModal('db:${l.dbId||idx}')">Edit</button></td>
    </tr>`;
  }).join('');
}

/* ─── Master: Export confirm (v40.1 — checklist removed, replaced with conditional review warning) ───
   Admin export is intentionally NOT gated (admin override) — this is a heads-up, not a block.
   Flow: no flagged records → straight to format picker. Flagged records → warning modal first,
   with "Review now" (jumps to needs-review filter) or "Export anyway" (proceeds to format picker). */
let masterExportRange={from:null,to:null,siteF:'',empF:''};
// v44.0 Build 3: when the admin Submissions panel triggers an export (per-site or all-sites),
// this holds a callback that stamps the included employees' status rows to 'exported' once the
// PDF/Excel generation finishes. Set by openSubmissionsExport(), consumed + cleared by
// doMasterExcelZip()/generateMasterPDF() right after they finish building the file. The
// ad-hoc Report-tab export never sets this, so it never touches pt_timecard_status.
let _pendingExportStampFn=null;
let _masterReviewList=[];
function openMasterExportConfirm(){
  const logs=_masterLogs||[];
  if(!logs.length){showNotif('!','No records','Adjust filters to include at least one record','#EF9F27',2200);return}
  masterExportRange={logs};
  const needsReview=logs.filter(l=>l.autoClocked);
  if(needsReview.length){
    showMasterReviewWarning(needsReview);
  } else {
    showMasterFormatModal();
  }
}
function showMasterReviewWarning(list){
  _masterReviewList=list;
  document.getElementById('master-review-count').textContent=list.length;
  document.getElementById('master-review-plural').textContent=list.length===1?'':'es';
  document.getElementById('master-review-list').style.display='none';
  document.getElementById('master-review-list').innerHTML='';
  document.getElementById('master-review-toggle').textContent='Show details \u25be';
  document.getElementById('master-review-modal').style.display='flex';
}
function toggleMasterReviewList(){
  const el=document.getElementById('master-review-list');
  const btn=document.getElementById('master-review-toggle');
  const show=el.style.display==='none';
  if(show&&!el.innerHTML){
    el.innerHTML=_masterReviewList.map(l=>`<div style="padding:5px 0;border-bottom:0.5px solid var(--bdr);">
        <strong style="color:var(--txt);">${l.name}</strong>
        <span style="color:var(--txt2);font-size:11px;display:block;">Clocked in ${fmtDt(l.in)} \u00b7 auto-out at 12h</span>
      </div>`).join('');
  }
  el.style.display=show?'block':'none';
  btn.textContent=show?'Hide details \u25b4':'Show details \u25be';
}
function closeMasterReviewModal(){
  document.getElementById('master-review-modal').style.display='none';
}
function masterReviewGoNow(){
  closeMasterReviewModal();
  goToReport({flags:true}); // jumps the master log into the needs-review filter (v35.7 pattern)
}
function masterReviewExportAnyway(){
  closeMasterReviewModal();
  showMasterFormatModal();
}
function showMasterFormatModal(){
  document.getElementById('master-format-modal').style.display='flex';
}
function closeMasterFormatModal(){
  document.getElementById('master-format-modal').style.display='none';
}
/* ─── Master: Excel Pack export (v40.0) ───
   Replaces the old CSV export. Builds one .xlsx per worker, matching the GM's
   payroll template (loaded from the embedded blank template), bundled into a .zip.

   Template cell map (per worker sheet):
     B2  = employee code        (no DB field yet → left blank, wired for future)
     B3  = employee name
     H3  = pay-period start date
     Week 1 job headers: B5 / E5 / H5   (up to 3 jobsites)
     Week 2 job headers: B24 / E24 / H24
     Day grid — 2 rows per day (Sun→Sat), for up to 2 activities:
       Week 1 rows: Sun 8-9, Mon 10-11, Tue 12-13, Wed 14-15, Thu 16-17, Fri 18-19, Sat 20-21
       Week 2 rows: Sun 27-28, Mon 29-30, Tue 31-32, Wed 33-34, Thu 35-36, Fri 37-38, Sat 39-40
     Job column-groups → (Code col, Hrs col): Job1 C/D, Job2 F/G, Job3 I/J  (Extra cols blank)
   Rules: hours split ½/½ when a day+jobsite has 2 activity codes; full hours on row 1
   when 1 code. Pre-built K-column/Total formulas are left untouched. OT ignored.
   The template's stray D43/G43 values (Julio leftovers) are reset to formulas.        */

function _xlB64ToU8(b64){
  const bin=atob(b64);const u=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u;
}
function _xlSanitize(s){return String(s||'').replace(/[\/\\:*?"<>|]/g,'-').replace(/\s+/g,' ').trim();}
function _xlNumericCode(actName,codeMap){
  const raw=codeMap[actName];if(!raw)return null;
  const digits=String(raw).replace(/\D/g,'');if(!digits)return null;
  const n=Number(digits);return Number.isFinite(n)?n:digits;
}
function _xlRound2(n){return Math.round((n+Number.EPSILON)*100)/100;}

async function doMasterExcelZip(){
  if(typeof ExcelJS==='undefined'||typeof JSZip==='undefined'||!window.PAYROLL_TEMPLATE_B64){
    showCustomAlert('Export unavailable','The Excel/zip libraries or the payroll template did not load. Check your connection and reload the app.');return;
  }
  const logs=(_masterLogs||masterExportRange.logs||[]).filter(l=>l.out&&paidHours(l)!=null);
  if(!logs.length){showCustomAlert('No data','No completed punches to export. (Records still clocked in are skipped.)');return;}

  // ── Pay-period bounds (drive week split + filenames) ──
  const fromV=document.getElementById('m-log-from').value;
  const toV=document.getElementById('m-log-to').value;
  const periodStart=fromV?new Date(fromV+'T00:00:00'):new Date(Math.min(...logs.map(l=>l.in.getTime())));
  const periodEndStr=toV||toDateStr(new Date(Math.max(...logs.map(l=>l.in.getTime()))));
  const startMidnight=new Date(periodStart.getFullYear(),periodStart.getMonth(),periodStart.getDate()).getTime();
  const h3Str=periodStart.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'});

  // ── Activity name → numeric code map ──
  const codeMap={};(ALL_ACTIVITIES||ACTIVITIES||[]).forEach(a=>{if(a.code)codeMap[a.name]=a.code;});

  // ── Group by employee → week → jobsite → date ──
  const sorted=[...logs].sort((a,b)=>a.in-b.in);
  const emps={};const overflowWarn=[];const multiCodeWarn=[];const outsideWarn=[];
  sorted.forEach(l=>{
    const dayMidnight=new Date(l.in.getFullYear(),l.in.getMonth(),l.in.getDate()).getTime();
    const dayDiff=Math.floor((dayMidnight-startMidnight)/86400000);
    const week=dayDiff<7?0:1;
    if(dayDiff<0||dayDiff>13){outsideWarn.push(l.name);return;} // outside the 14-day grid
    const ph=paidHours(l);if(!ph||ph<=0)return;
    const site=l.jobsite||'(No site)';
    const e=emps[l.empId]||(emps[l.empId]={name:l.name,weeks:[{order:[],sites:{}},{order:[],sites:{}}]});
    const W=e.weeks[week];
    if(!W.sites[site]){W.sites[site]={};W.order.push(site);}
    const dk=toDateStr(l.in);
    const cell=W.sites[site][dk]||(W.sites[site][dk]={dow:l.in.getDay(),hours:0,codes:[]});
    cell.hours+=ph;
    (l.activity||[]).forEach(name=>{const c=_xlNumericCode(name,codeMap);if(c!=null&&!cell.codes.includes(c))cell.codes.push(c);});
  });

  const empList=Object.values(emps);
  if(!empList.length){showCustomAlert('No data','No completed punches to export.');return;}

  // ── Build each worker's file(s) ──
  const tplBytes=window.PAYROLL_TEMPLATE_B64;
  const slotCols=[{c:'C',h:'D'},{c:'F',h:'G'},{c:'I',h:'J'}];          // Job1, Job2, Job3
  const headWk1=['B5','E5','H5'];const headWk2=['B24','E24','H24'];
  const weekBase=[8,27];                                                // top of each week's day grid

  function placeDay(ws,weekIdx,slotIdx,cell){
    const base=weekBase[weekIdx];
    const r1=base+2*cell.dow;const r2=r1+1;
    const col=slotCols[slotIdx];
    const hrs=_xlRound2(cell.hours);
    const codes=cell.codes;
    if(codes.length<=1){
      if(codes.length===1)ws.getCell(col.c+r1).value=codes[0];
      ws.getCell(col.h+r1).value=hrs;
    }else if(codes.length===2){
      ws.getCell(col.c+r1).value=codes[0];ws.getCell(col.h+r1).value=_xlRound2(hrs/2);
      ws.getCell(col.c+r2).value=codes[1];ws.getCell(col.h+r2).value=_xlRound2(hrs/2);
    }else{ // 3+ codes same jobsite/day (rare, parked for GM) — first in row 1, rest joined in row 2
      ws.getCell(col.c+r1).value=codes[0];ws.getCell(col.h+r1).value=_xlRound2(hrs/2);
      ws.getCell(col.c+r2).value=codes.slice(1).join('/');ws.getCell(col.h+r2).value=_xlRound2(hrs/2);
      multiCodeWarn.push(ws._ptEmpName||'');
    }
  }

  const zip=new JSZip();let fileCount=0;
  showNotif('⏳','Building Excel pack','Generating timesheets…','#2563eb',60000);

  for(const emp of empList){
    const maxJobs=Math.max(emp.weeks[0].order.length,emp.weeks[1].order.length);
    const chunks=Math.max(1,Math.ceil(maxJobs/3));
    if(maxJobs>3)overflowWarn.push(emp.name);
    for(let c=0;c<chunks;c++){
      const wb=new ExcelJS.Workbook();
      await wb.xlsx.load(_xlB64ToU8(tplBytes).buffer);
      const ws=wb.worksheets[0];ws._ptEmpName=emp.name;
      // Header
      ws.getCell('B3').value=emp.name;
      ws.getCell('H3').value=h3Str;
      // ws.getCell('B2').value = <employee code>  // no DB field yet
      // Fix stray leftover values → formulas (so ST total is correct on every sheet)
      ws.getCell('D43').value={formula:'D22+D41'};
      ws.getCell('G43').value={formula:'G22+G41'};
      // Per-week: up to 3 jobsites in this chunk
      [0,1].forEach(weekIdx=>{
        const W=emp.weeks[weekIdx];
        const sites=W.order.slice(c*3,c*3+3);
        const heads=weekIdx===0?headWk1:headWk2;
        sites.forEach((site,slotIdx)=>{
          const jd=JOBSITE_DATA[site];
          ws.getCell(heads[slotIdx]).value=(jd&&jd.jobNumber)?jd.jobNumber:site; // abbrev Job# field, fallback to name
          Object.values(W.sites[site]).forEach(cell=>placeDay(ws,weekIdx,slotIdx,cell));
        });
      });
      const buf=await wb.xlsx.writeBuffer();
      const suffix=chunks>1?` (${c+1})`:'';
      const fname=`${_xlSanitize(emp.name)} - ${periodEndStr}${suffix}.xlsx`;
      zip.file(fname,buf);fileCount++;
    }
  }

  // ── Zip filename = active filter (jobsite and/or employee) + period end ──
  const siteF=document.getElementById('m-filter-site').value;
  const empF=document.getElementById('m-filter-emp').value;
  const empFName=empF?(employees.find(e=>e.id===empF)?.name||''):'';
  let filterName;
  if(siteF&&empFName)filterName=`${siteF} - ${empFName}`;
  else if(siteF)filterName=siteF;
  else if(empFName)filterName=empFName;
  else filterName='All Records';
  const zipName=`${_xlSanitize(filterName)} - ${periodEndStr}.zip`;

  const blob=await zip.generateAsync({type:'blob'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=zipName;a.click();URL.revokeObjectURL(url);
  closeMasterFormatModal();
  if(overflowWarn.length)msg+=` · ${[...new Set(overflowWarn)].length} had 4+ sites (extra sheet added)`;
  showNotif('✓','Excel pack exported',msg,'#1D9E75',4500);
  if(outsideWarn.length)console.warn('Excel export: punches outside the 14-day grid were skipped for:',[...new Set(outsideWarn)]);
  if(multiCodeWarn.length)console.warn('Excel export: 3+ activity codes at one jobsite/day (parked GM case) for:',[...new Set(multiCodeWarn.filter(Boolean))]);
  // v44.0 Build 3: if this export came from the admin Submissions panel, stamp stage='exported'.
  if(_pendingExportStampFn){const fn=_pendingExportStampFn;_pendingExportStampFn=null;await fn();}
}
function generateMasterPDF(){
  const {jsPDF}=window.jspdf;
  const logs=_masterLogs||masterExportRange.logs||[];
  if(!logs.length){showCustomAlert('No data','No punch records to export.');return}

  // ── Helpers ──
  const fmtTime=d=>d instanceof Date?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'—';
  const fromV=document.getElementById('m-log-from').value;
  const toV=document.getElementById('m-log-to').value;
  const periodFrom=fromV?new Date(fromV+'T00:00:00').toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'}):'';
  const periodTo=toV?new Date(toV+'T00:00:00').toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'}):'';

  // ── Activity code lookup ──
  const actCodeMap={};
  (ALL_ACTIVITIES||ACTIVITIES||[]).forEach(a=>{if(a.code)actCodeMap[a.name]=a.code;});
  function formatTaskCode(actName){const code=actCodeMap[actName];return code?`${code} (${actName})`:actName;}

  // ── v47.0: Group by employee (consolidated — one card per employee, all sites) ──
  const empMap={};
  logs.forEach(l=>{
    const empId=l.empId||l.name;
    if(!empMap[empId])empMap[empId]={name:l.name,dept:l.dept,punches:[],sites:new Set()};
    empMap[empId].punches.push(l);
    if(l.jobsite)empMap[empId].sites.add(l.jobsite);
  });
  const empIds=Object.keys(empMap).sort((a,b)=>empMap[a].name.localeCompare(empMap[b].name));

  // ── Consolidate: group by date+jobsite, variable-height rows ──
  function consolidate(punches){
    const dayMap={};
    punches.forEach(p=>{
      const at=adjustedTimes(p);
      const aIn=at.in,aOut=at.out;
      const dayKey=p.in.toDateString()+'|'+(p.jobsite||'');
      if(!dayMap[dayKey])dayMap[dayKey]={date:aIn,clockIn:aIn,clockOut:aOut,hrs:0,acts:new Set(),jobsite:p.jobsite||'—',hasAuto:false,hasEstimated:false};
      const d=dayMap[dayKey];
      if(aIn<d.clockIn)d.clockIn=aIn;
      if(aOut&&(!d.clockOut||aOut>d.clockOut))d.clockOut=aOut;
      const ph=paidHours(p);if(ph!=null)d.hrs+=ph;
      (p.activity||[]).forEach(a=>{if(a!=='Auto-clocked')d.acts.add(a);});
      if(p.autoClocked)d.hasAuto=true;
      if(p.estimatedOut)d.hasEstimated=true;
    });
    return Object.values(dayMap).sort((a,b)=>a.date-b.date||a.jobsite.localeCompare(b.jobsite));
  }

  const doc=new jsPDF({orientation:'portrait',unit:'mm',format:'letter'});
  const PW=215.9,PH=279.4;
  const ML=14,MR=14,MT=14;
  const CW=PW-ML-MR;

  // ── Brand colours ──
  const GREEN=[45,122,45];
  const AMBER_COL=[214,123,17];
  const TAN=[251,213,147];
  const TAN_DARK=[200,140,60];
  const BLACK=[30,30,30];
  const WHITE=[255,255,255];
  const LGRAY=[245,245,245];
  const AMBER_BG=[255,243,220];
  const RED_TEXT=[163,45,45];
  const SITE_HDR=[230,240,230];

  const COL={date:38,site:28,in:24,out:24,hrs:16,task:0};
  COL.task=CW-COL.date-COL.site-COL.in-COL.out-COL.hrs;
  const COL_WIDTHS=[COL.date,COL.site,COL.in,COL.out,COL.hrs,COL.task];
  const colLabels=['DATE','JOBSITE','CLOCK IN','CLOCK OUT','HOURS','TASK CODE'];
  const ROW_H=6.5;
  const lineH=4;

  let pageIdx=0;

  empIds.forEach(empId=>{
      if(pageIdx>0)doc.addPage();
      pageIdx++;
      const emp=empMap[empId];
      const rows=consolidate(emp.punches);
      const allSites=[...emp.sites].sort().join(', ');
      let y=MT;

      // ── HEADER BAND ──
      doc.setFillColor(...GREEN);
      doc.rect(ML,y,CW,12,'F');
      doc.setTextColor(...WHITE);
      doc.setFont('helvetica','bold');
      doc.setFontSize(12);
      doc.text('Panorama Building Systems \u2014 PanoramaTrack',ML+3,y+5);
      doc.setFont('helvetica','normal');
      doc.setFontSize(8.5);
      doc.text(`Pay period: ${periodFrom} \u2013 ${periodTo}`,ML+3,y+10);
      doc.setFont('helvetica','bold');doc.setFontSize(7);doc.setTextColor(...WHITE);
      doc.text('MASTER ADMIN EXPORT',ML+CW-3,y+6.5,{align:'right'});
      y+=14;

      // ── TIME CARD title ──
      doc.setTextColor(...BLACK);
      doc.setFont('helvetica','bold');
      doc.setFontSize(14);
      doc.text('TIME CARD',PW/2,y+6,{align:'center'});
      y+=11;

      // ── Employee info block (v47.0: JOBSITE(S) lists all worked sites) ──
      doc.setFontSize(8.5);
      doc.setFont('helvetica','bold');doc.text('NAME:',ML,y+3.5);
      doc.setFont('helvetica','normal');doc.text(emp.name,ML+16,y+3.5);
      doc.setFont('helvetica','bold');doc.text('JOBSITE(S):',ML+CW*0.52,y+3.5);
      doc.setFont('helvetica','normal');doc.text(allSites,ML+CW*0.52+24,y+3.5);
      y+=6;
      doc.setFont('helvetica','bold');doc.text('DEPARTMENT:',ML,y+3.5);
      doc.setFont('helvetica','normal');doc.text(emp.dept||'—',ML+27,y+3.5);
      y+=8;

      // ── Divider ──
      doc.setDrawColor(...TAN_DARK);doc.setLineWidth(0.4);
      doc.line(ML,y,ML+CW,y);y+=3;

      // ── Table header ──
      doc.setFillColor(...TAN);doc.rect(ML,y,CW,ROW_H,'F');
      doc.setDrawColor(...TAN_DARK);doc.setLineWidth(0.25);
      let cx=ML;COL_WIDTHS.forEach(w=>{cx+=w;if(cx<ML+CW)doc.line(cx,y,cx,y+ROW_H);});
      doc.rect(ML,y,CW,ROW_H);
      doc.setFont('helvetica','bold');doc.setFontSize(7.5);doc.setTextColor(...BLACK);
      let lx=ML;COL_WIDTHS.forEach((w,i)=>{doc.text(colLabels[i],lx+w/2,y+ROW_H-1.8,{align:'center'});lx+=w;});
      y+=ROW_H;

      // ── Table rows ──
      doc.setFont('helvetica','normal');doc.setFontSize(7.5);
      let totalHrs=0;

      rows.forEach((r,ri)=>{
        const taskLines=r.hasAuto?['Auto-clocked']:([...r.acts].map(a=>formatTaskCode(a)));
        if(!taskLines.length)taskLines.push('—');
        const rH=Math.max(ROW_H,taskLines.length*lineH+2);

        if(y+rH>PH-50){
          doc.addPage();y=MT;
          doc.setFillColor(...GREEN);doc.rect(ML,y,CW,7,'F');
          doc.setFont('helvetica','bold');doc.setFontSize(8);doc.setTextColor(...WHITE);
          doc.text(`${emp.name} \u2014 continued`,ML+3,y+5);
          y+=9;
          doc.setFillColor(...TAN);doc.rect(ML,y,CW,ROW_H,'F');
          doc.setDrawColor(...TAN_DARK);doc.setLineWidth(0.25);
          let cx2=ML;COL_WIDTHS.forEach(w=>{cx2+=w;if(cx2<ML+CW)doc.line(cx2,y,cx2,y+ROW_H);});
          doc.rect(ML,y,CW,ROW_H);
          doc.setFont('helvetica','bold');doc.setFontSize(7.5);doc.setTextColor(...BLACK);
          let lx2=ML;COL_WIDTHS.forEach((w,i)=>{doc.text(colLabels[i],lx2+w/2,y+ROW_H-1.8,{align:'center'});lx2+=w;});
          y+=ROW_H;
          doc.setFont('helvetica','normal');doc.setFontSize(7.5);
        }

        const rowBg=ri%2===0?WHITE:LGRAY;
        const bgColor=r.hasEstimated?AMBER_BG:rowBg;
        doc.setFillColor(...bgColor);doc.rect(ML,y,CW,rH,'F');
        doc.setDrawColor(...TAN_DARK);doc.setLineWidth(0.25);
        let rx=ML;COL_WIDTHS.forEach(w=>{rx+=w;if(rx<ML+CW)doc.line(rx,y,rx,y+rH);});
        doc.rect(ML,y,CW,rH);

        const dateStr=r.date.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'});
        const inStr=fmtTime(r.clockIn);
        const outStr=r.clockOut?(fmtTime(r.clockOut)+(r.hasEstimated?' (est.)':'')):'—';
        const hrsStr=r.hrs>0?r.hrs.toFixed(2):'—';
        totalHrs+=r.hrs;

        const textY=y+4;
        doc.setTextColor(...(r.hasAuto?RED_TEXT:BLACK));
        let tx=ML;
        doc.text((r.hasAuto?'! ':'')+dateStr,tx+2,textY);tx+=COL.date;
        doc.setTextColor(...BLACK);
        doc.text(r.jobsite,tx+COL.site/2,textY,{align:'center'});tx+=COL.site;
        doc.text(inStr,tx+COL.in/2,textY,{align:'center'});tx+=COL.in;
        doc.setFont('helvetica',r.hasEstimated?'italic':'normal');
        doc.text(outStr,tx+COL.out/2,textY,{align:'center'});tx+=COL.out;
        doc.setFont('helvetica','bold');
        doc.text(hrsStr,tx+COL.hrs-2,textY,{align:'right'});tx+=COL.hrs;
        doc.setFont('helvetica','normal');
        taskLines.forEach((line,li)=>{doc.text(line,tx+2,textY+li*lineH);});
        y+=rH;
      });

      // ── TOTAL row ──
      const TOT_H=7;
      doc.setFillColor(...TAN);doc.rect(ML,y,CW,TOT_H,'F');
      doc.setDrawColor(...TAN_DARK);doc.rect(ML,y,CW,TOT_H);
      const hrsX=ML+COL.date+COL.site+COL.in+COL.out;
      doc.line(hrsX,y,hrsX,y+TOT_H);
      doc.setFont('helvetica','bold');doc.setFontSize(8.5);doc.setTextColor(...BLACK);
      doc.text('TOTAL',ML+2,y+TOT_H-2);
      doc.text(totalHrs.toFixed(2),hrsX+COL.hrs-2,y+TOT_H-2,{align:'right'});
      y+=TOT_H+5;

      // ── Footnotes ──
      if(rows.some(r=>r.hasAuto)){
        doc.setFont('helvetica','italic');doc.setFontSize(7);doc.setTextColor(...RED_TEXT);
        doc.text('! Records marked ! were auto-clocked out at 12 hours and may require review.',ML,y);
        y+=4.5;doc.setTextColor(...BLACK);
      }

      // ── Signature line ──
      const sigY=Math.max(y+10,PH-MT-25);
      doc.setFont('helvetica','normal');doc.setFontSize(8);
      doc.setDrawColor(...BLACK);doc.setLineWidth(0.3);
      doc.line(ML,sigY,ML+70,sigY);
      doc.text('Master admin approval',ML,sigY+4);
      doc.line(ML+CW-50,sigY,ML+CW,sigY);
      doc.text('Date',ML+CW-50,sigY+4);
  });

  // ── Save ──
  const now=new Date();
  doc.save(`PanoramaTrack_MasterReport_${toDateStr(now)}.pdf`);
  closeMasterFormatModal();
  showNotif('✓','PDF generated',`${empIds.length} time card${empIds.length!==1?'s':''} downloaded`,'#1D9E75',3500);
  // v44.0 Build 3: if this export came from the admin Submissions panel, stamp stage='exported'.
  if(_pendingExportStampFn){const fn=_pendingExportStampFn;_pendingExportStampFn=null;fn();}
}
// _editEntry holds the current entry being edited (may come from DB query, not timeLog array)
let _editEntry=null;
async function openEditModal(ref){
  let entry=null;
  if(typeof ref==='string'&&ref.startsWith('db:')){
    const dbId=ref.slice(3);
    // Check memory first
    entry=timeLog.find(e=>String(e.dbId)===dbId);
    if(!entry){
      const {data}=await sb.from('punches').select('*').eq('id',dbId).single();
      if(data){entry=dbRowToEntry(data);}
    }
  } else {
    entry=timeLog[ref];
    editingIdx=ref;
  }
  if(!entry)return;
  _editEntry=entry;
  // Shared modal: ensure edit-mode UI (the add path toggles these the other way) — v37.0
  addingPunch=false;
  document.getElementById('edit-modal-title').textContent='Edit punch record';
  document.getElementById('edit-emp-wrap').style.display='';
  document.getElementById('add-emp-wrap').style.display='none';
  document.getElementById('edit-delete-wrap').style.display='';
  document.getElementById('edit-save-btn').textContent='Save changes';
  document.getElementById('in-quickset-add').style.display='none';
  document.getElementById('out-quickset-add').style.display='none';
  document.getElementById('out-quickset-edit').style.display='flex';
  editActs=new Set(entry.activity||[]);
  document.getElementById('edit-emp-name').value=entry.name;
  document.getElementById('edit-in').value=toLocal(entry.in);
  document.getElementById('edit-out').value=entry.out?toLocal(entry.out):'';
  const jSel=document.getElementById('edit-jobsite');
  jSel.innerHTML=JOBSITES.map(j=>`<option${entry.jobsite===j?' selected':''}>${j}</option>`).join('');
  buildEditActGrid();
  // Lunch waive decision block (v42.0) — only when this punch carries a waive request
  setupEditWaive(entry);
  document.getElementById('edit-err').textContent='';
  document.getElementById('edit-modal-bg').style.display='flex';
}
// Manual punch entry (v37.0) — reuses the edit modal in add mode.
// For an employee who forgot to clock in/out entirely. ctx = 'sup' | 'master' | 'subcorrect'.
function openAddPunchModal(ctx){
  addingPunch=true;
  addPunchCtx=(ctx==='sup')?'sup':(ctx==='subcorrect'?'subcorrect':'master');
  _editEntry=null;editingIdx=null;
  editActs=new Set();
  document.getElementById('edit-modal-title').textContent='Add manual punch';
  document.getElementById('edit-emp-wrap').style.display='none';
  document.getElementById('add-emp-wrap').style.display='';
  document.getElementById('edit-delete-wrap').style.display='none';
  document.getElementById('edit-save-btn').textContent='Add punch';
  document.getElementById('out-quickset-edit').style.display='none';
  document.getElementById('in-quickset-add').style.display='flex';
  document.getElementById('out-quickset-add').style.display='flex';
  // Employee dropdown — full active roster, alphabetical
  const roster=employees.filter(e=>e.active).slice().sort((a,b)=>a.name.localeCompare(b.name));
  document.getElementById('add-emp-select').innerHTML='<option value="">— select employee —</option>'+roster.map(e=>`<option value="${e.id}">${e.name}</option>`).join('');
  // v46.0: opened from the admin correction modal for a specific employee — pre-select them
  // (still changeable, but saves a step since we already know who this punch is for).
  if(ctx==='subcorrect'&&_adminCorrectEmpId)document.getElementById('add-emp-select').value=_adminCorrectEmpId;
  document.getElementById('edit-in').value='';
  document.getElementById('edit-out').value='';
  document.getElementById('edit-jobsite').innerHTML=JOBSITES.map(j=>`<option>${j}</option>`).join('');
  buildEditActGrid();
  // No lunch-waive decision on a brand-new manual punch (v42.0)
  const ww=document.getElementById('edit-waive-wrap');if(ww)ww.style.display='none';
  document.getElementById('edit-err').textContent='';
  document.getElementById('edit-modal-bg').style.display='flex';
}
/* ─── Quick-set time buttons (v40.1) ───
   Add Manual Punch: stamps Today/Yesterday at a fixed time onto either field.
   Edit Punch (fixing an auto-clock-out): stamps a fixed time onto the SAME DATE
   as whatever's currently in the Clock-in field — correct for fixing a past
   auto-clock, not just today's. */
function quickSetAddTime(fieldId,dayWord,hh,mm){
  const base=new Date();
  if(dayWord==='yesterday')base.setDate(base.getDate()-1);
  base.setHours(hh,mm,0,0);
  document.getElementById(fieldId).value=toLocal(base);
}
function quickSetEditOut(hh,mm){
  const inV=document.getElementById('edit-in').value;
  const base=inV?new Date(inV):(_editEntry&&_editEntry.in instanceof Date?new Date(_editEntry.in):new Date());
  base.setHours(hh,mm,0,0);
  document.getElementById('edit-out').value=toLocal(base);
}
/* v47.0: My Timecard edit modal's clock-out quick-set — same logic as quickSetEditOut
   but reads/writes the mytc-edit-in / mytc-edit-out fields. */
function quickSetMyTcEditOut(hh,mm){
  const inV=document.getElementById('mytc-edit-in').value;
  const base=inV?new Date(inV):(myTcEditingDbId?(() => {const e=myTcPunches.find(p=>String(p.dbId)===String(myTcEditingDbId));return e&&e.in instanceof Date?new Date(e.in):new Date();})():new Date());
  base.setHours(hh,mm,0,0);
  document.getElementById('mytc-edit-out').value=toLocal(base);
}
/* ─── Lunch waive decision in edit modal (v42.0) ───
   _editWaiveDecision: the pending decision to write on save.
     null  = no change (leave stored value as-is)
     true  = approve · false = deny
   Only relevant when the punch carries lunch_waive_requested=true. */
let _editWaiveDecision=null;
function setupEditWaive(entry){
  const wrap=document.getElementById('edit-waive-wrap');
  _editWaiveDecision=null;
  if(!wrap)return;
  if(!entry||entry.lunchWaiveRequested!==true){wrap.style.display='none';return}
  wrap.style.display='';
  // Seed the displayed decision from the stored state (null/true/false)
  _renderEditWaive(entry.lunchWaived);
}
function _renderEditWaive(state){
  // state: null pending · true approved · false denied
  const status=document.getElementById('edit-waive-status');
  const aBtn=document.getElementById('edit-waive-approve');
  const dBtn=document.getElementById('edit-waive-deny');
  if(aBtn)aBtn.style.outline=(state===true)?'2px solid var(--green)':'';
  if(dBtn)dBtn.style.outline=(state===false)?'2px solid var(--red)':'';
  if(status){
    if(state===true){status.textContent='✓ Approved — lunch will not be deducted';status.style.color='var(--green)';}
    else if(state===false){status.textContent='✗ Denied — unpaid lunch still applies';status.style.color='var(--red)';}
    else{status.textContent='Pending — choose Approve or Deny';status.style.color='var(--txt2)';}
  }
}
function setEditWaive(approve){
  _editWaiveDecision=approve; // true or false
  _renderEditWaive(approve);
}
function buildEditActGrid(){
  document.getElementById('edit-act-grid').innerHTML=[...ACTIVITIES].sort((a,b)=>a.name.localeCompare(b.name)).map(a=>`<button class="act-btn${editActs.has(a.name)?' sel':''}" id="eact_${a.name.replace(/\s/g,'_')}" onclick="toggleEditAct('${a.name}')">${a.name}</button>`).join('');
}
function toggleEditAct(a){
  if(editActs.has(a))editActs.delete(a);else editActs.add(a);
  document.getElementById('eact_'+a.replace(/\s/g,'_')).classList.toggle('sel',editActs.has(a));
}
function closeEditModal(){
  document.getElementById('edit-modal-bg').style.display='none';
  editingIdx=null;_editEntry=null;addingPunch=false;
}

function confirmDeletePunch(){
  const e=_editEntry||timeLog[editingIdx];
  if(!e)return;
  const label=e.name+' — '+fmtDt(e.in);
  showCustomConfirm(
    'Delete punch record?',
    `This will permanently delete the punch for ${label}.`,
    'This cannot be undone. The hours for this shift will be permanently lost.',
    'Delete permanently',
    'var(--red)',
    ()=>deletePunch(e)
  );
}

async function deletePunch(e){
  if(e.dbId){
    const {error}=await sb.from('punches').delete().eq('id',e.dbId);
    if(error){showCustomAlert('Error','Could not delete punch: '+error.message);return}
  }
  // Remove from memory if present
  const memIdx=timeLog.findIndex(l=>l===e||(e.dbId&&l.dbId===e.dbId));
  if(memIdx>=0)timeLog.splice(memIdx,1);
  // v47.4: if deleting this punch left the site with no punches this period, drop its stale status row
  await cleanupOrphanStatusRow(e.empId,e.jobsite,periodContaining(e.in));
  closeEditModal();
  showNotif('✓','Punch deleted','Record permanently removed','#c47f17',2400);
  if(document.getElementById('spanel-log')?.style.display!=='none')refreshSupLog();
  if(document.getElementById('mpanel-log')?.style.display!=='none')refreshMasterLog();
  if(document.getElementById('admin-correct-modal-bg')?.style.display==='flex'){refreshAdminEmpCorrect();refreshSubmissionsPanel();}
}
async function saveEdit(){
  const err=document.getElementById('edit-err');
  // ── Manual add mode (v37.0): insert a brand-new punch ──
  if(addingPunch){
    const empId=document.getElementById('add-emp-select').value;
    if(!empId){err.textContent='Select an employee.';return}
    const emp=employees.find(x=>String(x.id)===String(empId));
    if(!emp){err.textContent='Employee not found — reopen and try again.';return}
    const aInV=document.getElementById('edit-in').value;const aOutV=document.getElementById('edit-out').value;
    if(!aInV){err.textContent='Clock in time is required.';return}
    const aIn=new Date(aInV);const aOut=aOutV?new Date(aOutV):null;
    if(aOut&&aOut<=aIn){err.textContent='Clock out must be after clock in.';return}
    const aSite=document.getElementById('edit-jobsite').value;
    const aActs=[...editActs];
    const payload={
      employee_id:emp.id,employee_name:emp.name,department:emp.dept,
      jobsite:aSite,clock_in:aIn.toISOString(),
      clock_out:aOut?aOut.toISOString():null,
      activities:aActs,auto_clocked:false,manual_entry:true
    };
    const {error}=await sb.from('punches').insert(payload);
    if(error){err.textContent='DB error: '+error.message;return}
    const ctx=addPunchCtx;
    closeEditModal();
    showNotif('✓','Punch added',emp.name+' — '+fmtDt(aIn),'#2f7d31',2600);
    if(ctx==='sup')refreshSupLog();
    else if(ctx==='subcorrect'){refreshAdminEmpCorrect();refreshSubmissionsPanel();}
    else refreshMasterLog();
    return;
  }
  const inV=document.getElementById('edit-in').value;const outV=document.getElementById('edit-out').value;
  if(!inV){err.textContent='Clock in time is required.';return}
  const newIn=new Date(inV);const newOut=outV?new Date(outV):null;
  if(newOut&&newOut<=newIn){err.textContent='Clock out must be after clock in.';return}
  const e=_editEntry||timeLog[editingIdx];
  const oldJobsite=e.jobsite,oldIn=e.in,oldEmpId=e.empId; // v47.4: pre-edit values for orphan cleanup
  const newJobsite=document.getElementById('edit-jobsite').value;
  const newActs=[...editActs];
  const wasAuto=e.autoClocked;
  const editedAfterAuto=wasAuto&&!!newOut;
  // Write to DB
  if(e.dbId){
    const upd={clock_in:newIn.toISOString(),jobsite:newJobsite,activities:newActs};
    if(newOut)upd.clock_out=newOut.toISOString();else upd.clock_out=null;
    if(editedAfterAuto){upd.auto_clocked=false;upd.edited_after_auto=true;}
    // Lunch waive decision (v42.0) — only write when a decision was made this session
    if(_editWaiveDecision!==null)upd.lunch_waived=_editWaiveDecision;
    const {error}=await sb.from('punches').update(upd).eq('id',e.dbId);
    if(error){err.textContent='DB error: '+error.message;return}
  }
  // Update memory
  e.in=newIn;e.out=newOut;e.jobsite=newJobsite;e.activity=newActs;
  if(editedAfterAuto){e.autoClocked=false;e.editedAfterAuto=true;}
  if(_editWaiveDecision!==null)e.lunchWaived=_editWaiveDecision;
  // v47.4: if this edit left the OLD site with no punches this period, drop its stale status row
  await cleanupOrphanStatusRow(oldEmpId,oldJobsite,periodContaining(oldIn));
  closeEditModal();
  if(document.getElementById('spanel-log')?.style.display!=='none')refreshSupLog();
  if(document.getElementById('mpanel-log')?.style.display!=='none')refreshMasterLog();
  // v46.0: admin correction modal (Submissions panel → tap a name) isn't a full-screen
  // panel, so it's not caught by the two checks above — check its own visibility instead.
  if(document.getElementById('admin-correct-modal-bg')?.style.display==='flex'){refreshAdminEmpCorrect();refreshSubmissionsPanel();}
}

/* ─── Supervisor modal ─── */
/* ─── Employee modal ─── */
function openEmpModal(id,ctx){
  editingEmpId=id||null;
  empModalContext=ctx||'master';
  document.getElementById('emp-modal-title').textContent=id?'Edit employee':'Add employee';
  const emp=id?employees.find(e=>e.id===id):null;
  document.getElementById('emp-name-inp').value=emp?emp.name:'';
  document.getElementById('emp-pin-inp').value=emp?emp.pin:'';
  // Build department dropdown from DEPARTMENTS
  rebuildDeptDropdown();
  document.getElementById('emp-dept-inp').value=emp?emp.dept:'';
  // Supervisor fields
  onEmpDeptChange();
  if(emp&&emp.dept==='Supervisor'){
    document.getElementById('emp-sup-pass').value=emp.supervisorPassword||'';
    // Build jobsite checkboxes
    const assigned=emp.supervisorJobsites||[];
    buildSupJobsiteChecks(assigned);
  }
  document.getElementById('emp-err').textContent='';
  // Permission gating: a supervisor editing ANOTHER supervisor cannot change PIN or password (admin only)
  const pinInp=document.getElementById('emp-pin-inp');
  const passField=document.getElementById('emp-sup-pass-field');
  const restrictNote=document.getElementById('emp-restrict-note');
  const restricted=ctx==='sup'&&emp&&emp.dept==='Supervisor'&&emp.id!==(activeSup&&activeSup.id);
  if(restricted){
    pinInp.readOnly=true;pinInp.disabled=true;pinInp.style.opacity='0.55';
    if(passField)passField.style.display='none';
    if(restrictNote)restrictNote.style.display='block';
  } else {
    pinInp.readOnly=false;pinInp.disabled=false;pinInp.style.opacity='';
    if(passField)passField.style.display='';
    if(restrictNote)restrictNote.style.display='none';
  }
  document.getElementById('emp-modal-bg').style.display='flex';
  setTimeout(()=>document.getElementById('emp-name-inp').focus(),80);
}

function onEmpDeptChange(){
  const dept=document.getElementById('emp-dept-inp').value;
  const supFields=document.getElementById('emp-sup-fields');
  if(dept==='Supervisor'){
    supFields.style.display='block';
    buildSupJobsiteChecks([]);
  } else {
    supFields.style.display='none';
  }
}

function buildSupJobsiteChecks(assigned){
  const grid=document.getElementById('emp-sup-jobsites');
  grid.innerHTML=JOBSITES.map(j=>{
    const chk=assigned.includes(j)?'checked':'';
    const cls=assigned.includes(j)?'chk-pill checked':'chk-pill';
    return `<label class="${cls}" id="empsjc_${j.replace(/\W/g,'_')}" onclick="toggleChkPill(this)"><input type="checkbox" value="${j}" ${chk} style="pointer-events:none;"/>${j}</label>`;
  }).join('');
}

function closeEmpModal(){document.getElementById('emp-modal-bg').style.display='none';editingEmpId=null;}

async function saveEmployee(){
  const name=document.getElementById('emp-name-inp').value.trim();
  const dept=document.getElementById('emp-dept-inp').value;
  const err=document.getElementById('emp-err');
  // Permission gating: supervisor editing another supervisor cannot change PIN/password
  const target=editingEmpId?employees.find(e=>e.id===editingEmpId):null;
  const restricted=empModalContext==='sup'&&target&&target.dept==='Supervisor'&&target.id!==(activeSup&&activeSup.id);
  const pin=restricted?target.pin:document.getElementById('emp-pin-inp').value.trim();
  if(!name||!pin||!dept){err.textContent='All fields are required.';return}
  if(!/^\d{4,6}$/.test(pin)){err.textContent='PIN must be 4–6 digits.';return}
  const dup=employees.find(e=>e.pin===pin&&e.id!==editingEmpId);
  if(dup){err.textContent='PIN already in use by '+dup.name+'.';return}

  // Supervisor-specific fields
  let supPass=null, supJobsites=[];
  if(dept==='Supervisor'){
    supPass=restricted?(target.supervisorPassword||''):document.getElementById('emp-sup-pass').value.trim();
    if(!supPass){err.textContent='Supervisor password is required.';return}
    // v44.1: enforce supervisor password uniqueness (mirrors the PIN uniqueness check
    // above). Matched by DB UNIQUE constraint on employees.supervisor_password so direct
    // SQL edits can't slip a duplicate through either. Skips self so a supervisor editing
    // their own record without changing the password isn't rejected.
    const passDup=employees.find(e=>e.supervisorPassword&&e.supervisorPassword===supPass&&e.id!==editingEmpId);
    if(passDup){err.textContent='Supervisor password already in use by '+passDup.name+'.';return}
    supJobsites=Array.from(document.querySelectorAll('#emp-sup-jobsites input:checked')).map(c=>c.value);
  }

  const dbPayload={name,pin,department:dept,active:true,
    supervisor_password:dept==='Supervisor'?supPass:null,
    supervisor_jobsites:dept==='Supervisor'?supJobsites:[]};

  if(editingEmpId){
    const {error}=await sb.from('employees').update(dbPayload).eq('id',editingEmpId);
    if(error){err.textContent='DB error: '+error.message;return}
    const e=employees.find(e=>e.id===editingEmpId);
    e.name=name;e.pin=pin;e.dept=dept;
    e.supervisorPassword=supPass;e.supervisorJobsites=supJobsites;
  }else{
    const {data,error}=await sb.from('employees').insert(dbPayload).select().single();
    if(error){err.textContent='DB error: '+error.message;return}
    employees.push({id:data.id,name,pin,dept,active:true,
      supervisorPassword:supPass,supervisorJobsites:supJobsites});
  }
  // Re-derive supervisors from employees
  supervisors=employees.filter(e=>e.dept==='Supervisor'&&e.active).map(e=>({
    id:e.id,name:e.name,password:e.supervisorPassword,jobsites:e.supervisorJobsites
  }));
  closeEmpModal();
  if(empModalContext==='sup')refreshSupEmps();
  else{refreshMasterEmps();populateMasterFilters();}
  showNotif('✓',name,editingEmpId?'Employee updated':'Employee added','#2d7a2d',2000);
}

async function toggleEmpActive(id){
  const e=employees.find(e=>e.id===id);if(!e)return;
  const newState=!e.active;
  const {error}=await sb.from('employees').update({active:newState}).eq('id',id);
  if(error){showCustomAlert('Error','Could not update employee: '+error.message);return}
  e.active=newState;
  supervisors=employees.filter(e=>e.dept==='Supervisor'&&e.active).map(e=>({
    id:e.id,name:e.name,password:e.supervisorPassword,jobsites:e.supervisorJobsites
  }));
  refreshMasterEmps();
  if(document.getElementById('s-emp-accordion'))refreshSupEmps();
}

/* ─── Export ─── */
// setPayPeriod replaced by setSupPeriod with fixed period calculator
/* ─── Export: shared DB query helper ───
   Fetches ALL punches for the period for employees who worked
   at least one shift at this supervisor's jobsite(s).
   This ensures a complete timecard even if employee worked multiple sites. ─── */
async function fetchExportLogs(from,to){
  const sites=activeSup?(activeSup.jobsites||[]):[];
  if(!sites.length)return[];
  // Step 1: find employee IDs who punched at this supervisor's sites in the period
  const {data:siteData,error:siteErr}=await sb.from('punches').select('employee_id')
    .in('jobsite',sites)
    .gte('clock_in',from.toISOString())
    .lte('clock_in',to.toISOString());
  if(siteErr){showCustomAlert('Error','Could not load export data: '+siteErr.message);return[];}
  const empIds=[...new Set((siteData||[]).map(r=>r.employee_id).filter(Boolean))];
  if(!empIds.length)return[];
  // Step 2: fetch ALL punches for those employees for the full period (any site)
  const {data,error}=await sb.from('punches').select('*')
    .in('employee_id',empIds)
    .gte('clock_in',from.toISOString())
    .lte('clock_in',to.toISOString())
    .order('clock_in',{ascending:true});
  if(error){showCustomAlert('Error','Could not load export data: '+error.message);return[];}
  return (data||[]).map(dbRowToEntry);
}

async function updateExportPreview(){
  const fV=document.getElementById('s-log-from').value;
  const tV=document.getElementById('s-log-to').value;
  const prev=document.getElementById('s-export-preview');
  if(!fV||!tV){prev.textContent='Select both dates to preview.';return}
  const[fy,fm,fd]=fV.split('-').map(Number);const from=new Date(fy,fm-1,fd,0,0,0,0);
  const[ty,tm,td]=tV.split('-').map(Number);const to=new Date(ty,tm-1,td,23,59,59,999);
  if(to<=from){prev.textContent='End date must be after start date.';return}
  prev.textContent='Loading…';
  const logs=await fetchExportLogs(from,to);
  const total=logs.reduce((s,l)=>s+(paidHours(l)||0),0);
  const flags=logs.filter(l=>l.autoClocked).length;
  const empCount=new Set(logs.map(l=>l.empId)).size;
  prev.innerHTML=`<strong>${logs.length}</strong> punch records · <strong>${empCount}</strong> employee${empCount!==1?'s':''} · <strong>${total.toFixed(1)}h</strong> total${flags?` · <strong style="color:#e07070;">${flags} ⚠️ need review</strong>`:''}`;
}
async function openExportConfirm(){
  const fV=document.getElementById('s-log-from').value;const tV=document.getElementById('s-log-to').value;
  const err=document.getElementById('s-export-err');
  if(!fV||!tV){err.textContent='Please select both dates.';return}
  const[fy2,fm2,fd2]=fV.split('-').map(Number);const from=new Date(fy2,fm2-1,fd2,0,0,0,0);
  const[ty2,tm2,td2]=tV.split('-').map(Number);const to=new Date(ty2,tm2-1,td2,23,59,59,999);
  if(to<=from){err.textContent='End date must be after start date.';return}
  err.textContent='';
  const logs=await fetchExportLogs(from,to);
  if(!logs.length){err.textContent='No punch records found for this date range and jobsite(s).';return}

  // ── Review gate: block submit while any punch in this report still needs attention ──
  // (Supervisors only — master admin export path is intentionally not gated.)
  // Two kinds of outstanding item (v42.0):
  //   1. auto-clocked punches awaiting a real clock-out (auto_clocked flips false on edit)
  //   2. pending lunch-waive requests awaiting an approve/deny decision
  // Both clear automatically as they're addressed. Applies to preliminary AND final.
  const needsReview=logs.filter(l=>l.autoClocked);
  const pendingWaives=logs.filter(l=>isPendingWaive(l));
  if(needsReview.length||pendingWaives.length){
    showReviewGate(needsReview,pendingWaives);
    return;
  }

  // Determine if this is a preliminary (period not yet complete)
  const isPrelim=to>new Date();
  const periodStart=toDateStr(from);const periodEnd=toDateStr(to);

  // If preliminary — check for open punches and require estimated clock-out
  if(isPrelim){
    const openPunches=logs.filter(l=>!l.out);
    if(openPunches.length>0){
      // Show estimated clock-out modal — mandatory
      exportRange={from,to,logs,periodStart,periodEnd,dups:[],isPrelim:true,estimatedOut:null};
      showEstModal(openPunches);
      return;
    }
    // Prelim but no open punches — proceed normally but flag as prelim
    exportRange={from,to,logs,periodStart,periodEnd,dups:[],isPrelim:true,estimatedOut:null};
  } else {
    exportRange={from,to,logs,periodStart,periodEnd,dups:[],isPrelim:false,estimatedOut:null};
  }

  await checkDupsAndProceed();
}

// ── Review gate modal (v42.0) — blocks supervisor submit while items are unresolved.
//    Handles two kinds: auto-clocked punches and pending lunch-waive requests. ──
let _reviewGateWaives=[]; // pending-waive entries currently shown, for bulk approve
function showReviewGate(autoList,waiveList){
  autoList=autoList||[];waiveList=waiveList||[];
  _reviewGateWaives=waiveList;

  // Section 1 — auto-clocked
  const autoSec=document.getElementById('review-gate-auto-section');
  const autoEl=document.getElementById('review-gate-list');
  if(autoList.length){
    autoSec.style.display='';
    autoEl.innerHTML=autoList.map(l=>`<div style="padding:5px 0;border-bottom:0.5px solid var(--bdr);">
        <strong style="color:var(--txt);">${l.name}</strong>
        <span style="color:var(--txt2);font-size:11px;display:block;">Clocked in ${fmtDt(l.in)} · auto-out at 12h</span>
      </div>`).join('');
  } else { autoSec.style.display='none'; autoEl.innerHTML=''; }

  // Section 2 — pending lunch waives, grouped by employee with a bulk-approve button
  const waiveSec=document.getElementById('review-gate-waive-section');
  const waiveEl=document.getElementById('review-gate-waive-list');
  if(waiveList.length){
    waiveSec.style.display='';
    const byEmp={};
    waiveList.forEach(l=>{(byEmp[l.empId]=byEmp[l.empId]||{name:l.name,recs:[]}).recs.push(l);});
    waiveEl.innerHTML=Object.entries(byEmp).map(([empId,d])=>{
      const days=d.recs.map(l=>`<span style="color:var(--txt2);font-size:11px;display:block;">${fmtDt(l.in)}</span>`).join('');
      return `<div style="padding:7px 0;border-bottom:0.5px solid var(--bdr);">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div><strong style="color:var(--txt);">${d.name}</strong>
            <span style="color:var(--txt2);font-size:11px;"> · ${d.recs.length} day${d.recs.length!==1?'s':''}</span>
          </div>
          <button class="btn-sm" style="background:var(--green);color:#fff;flex-shrink:0;" onclick="approveAllWaivesFor('${empId}')">Approve all</button>
        </div>
        <div style="margin-top:3px;">${days}</div>
      </div>`;
    }).join('');
  } else { waiveSec.style.display='none'; waiveEl.innerHTML=''; }

  document.getElementById('review-gate-bg').style.display='flex';
}
// Bulk-approve every pending waive for one employee, straight from the gate (v42.0).
async function approveAllWaivesFor(empId){
  const recs=_reviewGateWaives.filter(l=>String(l.empId)===String(empId)&&l.dbId);
  if(!recs.length)return;
  const ids=recs.map(l=>l.dbId);
  const {error}=await sb.from('punches').update({lunch_waived:true}).in('id',ids);
  if(error){showCustomAlert('Error','Could not approve waives: '+error.message);return}
  // Heal any in-memory copies
  recs.forEach(r=>{const m=timeLog.find(l=>l.dbId===r.dbId);if(m)m.lunchWaived=true;r.lunchWaived=true;});
  showNotif('✓','Waives approved',recs.length+' day'+(recs.length!==1?'s':'')+' approved','#2f7d31',2400);
  // Re-run the gate check by re-opening the export flow so the gate clears / advances
  closeReviewGate();
  openExportConfirm();
}
function closeReviewGate(){document.getElementById('review-gate-bg').style.display='none';}
function reviewGateGoNow(){
  closeReviewGate();
  const err=document.getElementById('s-export-err');if(err)err.textContent='';
  goToSupReport('review'); // jumps Time log into the needs-review filter (v35.7)
}

function showEstModal(openPunches){
  document.getElementById('est-open-count').textContent=
    `${openPunches.length} employee${openPunches.length!==1?' are':' is'} currently clocked in and will have estimated hours.`;
  // Default est time to now rounded to nearest 15 min
  const now=new Date();const m=Math.round(now.getMinutes()/15)*15;
  const hh=String(now.getHours()).padStart(2,'0');
  const mm=String(m>=60?0:m).padStart(2,'0');
  document.getElementById('est-time-input').value=`${hh}:${mm}`;
  buildEstEmployeeList(openPunches);
  document.getElementById('est-modal-err').textContent='';
  document.getElementById('est-clockout-modal-bg').style.display='flex';
}

function buildEstEmployeeList(openPunches){
  const timeVal=document.getElementById('est-time-input').value;
  const [h,m]=timeVal.split(':').map(Number);
  const list=document.getElementById('est-employee-list');
  list.innerHTML='<p style="font-weight:600;color:var(--txt);margin-bottom:6px;">Estimated hours per employee:</p>'+
    openPunches.map(l=>{
      const estOut=new Date(l.in);estOut.setHours(h,m,0,0);
      const hrs=Math.max(0,(estOut-l.in)/3600000);
      return `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:0.5px solid var(--bdr);">
        <span>${l.name}</span>
        <span style="color:var(--amber);">In: ${fmt(l.in)} → Est: ${timeVal} ≈ ${hrs.toFixed(2)}h</span>
      </div>`;
    }).join('');
}

// Update preview when time changes
document.addEventListener('change',function(e){
  if(e.target.id==='est-time-input'){
    const open=exportRange.logs?exportRange.logs.filter(l=>!l.out):[];
    if(open.length)buildEstEmployeeList(open);
  }
},{passive:true});

function closeEstModal(){document.getElementById('est-clockout-modal-bg').style.display='none';}

async function proceedWithEstimate(){
  const timeVal=document.getElementById('est-time-input').value;
  if(!timeVal){document.getElementById('est-modal-err').textContent='Please enter an estimated clock-out time.';return}
  const [h,m]=timeVal.split(':').map(Number);
  // Apply estimated clock-out to open punches in memory only
  const now=new Date();
  const openPunches=exportRange.logs.filter(l=>!l.out);
  openPunches.forEach(l=>{
    const estOut=new Date(l.in);estOut.setHours(h,m,0,0);
    // If est time is before clock-in (overnight edge), add a day
    if(estOut<=l.in)estOut.setDate(estOut.getDate()+1);
    l.estimatedOut=estOut; // mark as estimated — not written to DB
    l.out=estOut;          // used for PDF calculation
  });
  exportRange.estimatedOut=timeVal;
  closeEstModal();
  await checkDupsAndProceed();
}

async function checkDupsAndProceed(){
  const empIds=[...new Set(exportRange.logs.map(l=>l.empId).filter(Boolean))];
  const {data:dupData}=await sb.from('submissions')
    .select('*')
    .in('employee_id',empIds)
    .lte('period_start',exportRange.periodEnd)
    .gte('period_end',exportRange.periodStart);
  // For preliminary: only block on FINAL submissions, not other preliminaries
  const dups=(dupData||[]).filter(d=>d.status==='final');
  if(dups.length){
    const dupList=document.getElementById('dup-list');
    dupList.innerHTML=dups.map(d=>{
      const dt=new Date(d.submitted_at);
      return `<div style="padding:5px 0;border-bottom:0.5px solid var(--bdr);">
        <strong>${d.employee_name}</strong>
        <span style="color:var(--txt2);font-size:11px;display:block;">Final submission by ${d.submitted_by} on ${dt.toLocaleDateString([],{month:'short',day:'numeric'})} at ${dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>
      </div>`;
    }).join('');
    exportRange.dups=dups;
    document.getElementById('dup-modal-bg').style.display='flex';
    return;
  }
  exportRange.dups=[];
  openChecklist();
}

function closeDupModal(){document.getElementById('dup-modal-bg').style.display='none';}

function proceedSkipDups(){
  // Remove duplicate employees from logs
  const dupEmpIds=new Set(exportRange.dups.map(d=>d.employee_id));
  exportRange.logs=exportRange.logs.filter(l=>!dupEmpIds.has(l.empId));
  exportRange.skipDups=true;
  closeDupModal();
  if(!exportRange.logs.length){
    document.getElementById('s-export-err').textContent='All employees were already submitted. Nothing left to export.';
    return;
  }
  openChecklist();
}

function proceedIncludeDups(){
  exportRange.skipDups=false;
  closeDupModal();
  openChecklist();
}

function openChecklist(){
  ['chk1','chk2','chk3','chk4','chk5'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.checked=false;
  });
  document.getElementById('confirm-err').textContent='';
  document.getElementById('export-confirm-submit').onclick=doExport;
  // Show/hide preliminary elements
  const isPrelim=exportRange.isPrelim;
  const prelimSection=document.getElementById('checklist-prelim-section');
  const modalTitle=document.querySelector('#export-confirm-modal h3');
  const submitBtn=document.getElementById('export-confirm-submit');
  if(isPrelim){
    if(prelimSection)prelimSection.style.display='block';
    if(modalTitle)modalTitle.textContent='Preliminary preview — confirm';
    if(submitBtn)submitBtn.textContent='Generate preview PDF →';
    submitBtn.style.background='var(--amber)';
  } else {
    if(prelimSection)prelimSection.style.display='none';
    if(modalTitle)modalTitle.textContent='Preview PDF — confirm';
    if(submitBtn)submitBtn.textContent='Generate preview PDF';
    submitBtn.style.background='var(--green)';
  }
  document.getElementById('export-confirm-modal').style.display='flex';
}
function closeConfirmModal(){
  document.getElementById('export-confirm-modal').style.display='none';
  const submitBtn=document.getElementById('export-confirm-submit');
  submitBtn.style.display='';
  submitBtn.textContent='Generate preview PDF';
  submitBtn.onclick=doExport;
}
async function doExport(){
  const isPrelim=exportRange.isPrelim;
  const requiredChks=isPrelim?['chk1','chk2','chk3','chk4','chk5']:['chk1','chk2','chk3','chk4'];
  const all=requiredChks.every(id=>document.getElementById(id)?.checked);
  if(!all){document.getElementById('confirm-err').textContent='Please confirm all items above before submitting.';return}
  // Generate PDF first, THEN close modal — closing before save can interrupt download on mobile
  try{
    generatePDF();
  }catch(pdfErr){
    console.error('PDF error:',pdfErr);
    showCustomAlert('PDF Error','Could not generate PDF: '+pdfErr.message);
    return;
  }
  closeConfirmModal();
  // Record submissions — supervisor only, master admin bypasses
  if(activeSup&&exportRange.periodStart&&exportRange.periodEnd){
    const status=isPrelim?'preliminary':'final';
    const empIds=[...new Set((exportRange.logs||[]).map(l=>l.empId).filter(Boolean))];
    const empNames={};
    (exportRange.logs||[]).forEach(l=>{if(l.empId)empNames[l.empId]=l.name;});
    // For final: upsert (delete old preliminary, insert final)
    if(!isPrelim){
      // Delete any existing preliminary submissions for these employees + period
      await sb.from('submissions').delete()
        .in('employee_id',empIds)
        .eq('period_start',exportRange.periodStart)
        .eq('status','preliminary');
    }
    const records=empIds.map(id=>({
      employee_id:id,
      employee_name:empNames[id]||'Unknown',
      period_start:exportRange.periodStart,
      period_end:exportRange.periodEnd,
      submitted_by:activeSup.name,
      status
    }));
    if(records.length){
      const {error}=await sb.from('submissions').insert(records);
      if(error)console.warn('Submission record error:',error.message);
    }
    // If final, clear the preliminary reminder banner
    if(!isPrelim)dismissPrelimBanner();
    // If preliminary, store reminder info in sessionStorage
    if(isPrelim){
      const reviewDate=new Date(exportRange.to);
      // Next working day after period end
      reviewDate.setDate(reviewDate.getDate()+1);
      if(reviewDate.getDay()===6)reviewDate.setDate(reviewDate.getDate()+2);
      if(reviewDate.getDay()===0)reviewDate.setDate(reviewDate.getDate()+1);
      sessionStorage.setItem('prelim_reminder',JSON.stringify({
        period:`${exportRange.from.toLocaleDateString([],{month:'short',day:'numeric'})} – ${exportRange.to.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`,
        submittedAt:new Date().toISOString(),
        reviewDate:toDateStr(reviewDate),
        supId:activeSup.id
      }));
    }
  }
}

/* ─── PDF generation ─── */
function generatePDF(){
  const {jsPDF}=window.jspdf;
  const logs=exportRange.logs||[];
  if(!logs.length){showCustomAlert('No data','No punch records to export.');return}

  // ── Helpers ──
  const fmtTime=d=>d instanceof Date?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'—';
  const periodFrom=exportRange.from.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'});
  const periodTo=exportRange.to.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'});
  const isPrelim=exportRange.isPrelim||false;
  const estimatedOut=exportRange.estimatedOut||null;

  // ── Build activity lookup: name → code (from ACTIVITIES/ALL_ACTIVITIES) ──
  const actCodeMap={};
  (ALL_ACTIVITIES||ACTIVITIES||[]).forEach(a=>{if(a.code)actCodeMap[a.name]=a.code;});
  function formatTaskCode(actName){
    const code=actCodeMap[actName];
    return code?`${code} (${actName})`:actName;
  }

  // ── Group punches by employee ──
  const empMap={};
  logs.forEach(l=>{
    if(!empMap[l.empId]){
      empMap[l.empId]={name:l.name,dept:l.dept,punches:[],sites:new Set()};
    }
    empMap[l.empId].punches.push(l);
    if(l.jobsite)empMap[l.empId].sites.add(l.jobsite);
  });

  // ── Consolidate: group by date, keep jobsite per row (different sites = separate rows) ──
  function consolidate(punches){
    const dayMap={};
    punches.forEach(p=>{
      const at=adjustedTimes(p);   // effective in/out after pay rules (raw for synthetic punches)
      const aIn=at.in,aOut=at.out;
      // Key by date + jobsite so different sites on same day stay separate rows
      const dayKey=p.in.toDateString()+'|'+(p.jobsite||'');
      if(!dayMap[dayKey])dayMap[dayKey]={
        date:aIn,clockIn:aIn,clockOut:aOut,
        hrs:0,acts:new Set(),jobsite:p.jobsite||'—',
        hasAuto:false,hasEstimated:false
      };
      const d=dayMap[dayKey];
      if(aIn<d.clockIn)d.clockIn=aIn;
      if(aOut&&(!d.clockOut||aOut>d.clockOut))d.clockOut=aOut;
      const ph=paidHours(p);if(ph!=null)d.hrs+=ph;
      (p.activity||[]).forEach(a=>{if(a!=='Auto-clocked')d.acts.add(a);});
      if(p.autoClocked)d.hasAuto=true;
      if(p.estimatedOut)d.hasEstimated=true;
    });
    return Object.values(dayMap).sort((a,b)=>a.date-b.date||a.jobsite.localeCompare(b.jobsite));
  }

  const doc=new jsPDF({orientation:'portrait',unit:'mm',format:'letter'});
  const PW=215.9,PH=279.4;
  const ML=14,MR=14,MT=14;
  const CW=PW-ML-MR;

  // ── Brand colours ──
  const GREEN=[45,122,45];
  const AMBER_COL=[214,123,17];
  const TAN=[251,213,147];
  const TAN_DARK=[200,140,60];
  const BLACK=[30,30,30];
  const WHITE=[255,255,255];
  const LGRAY=[245,245,245];
  const AMBER_BG=[255,243,220];
  const RED_TEXT=[163,45,45];

  // ── Column widths — 6 cols — total = CW ~187.9mm ──
  // DATE(38) + SITE(28) + IN(24) + OUT(24) + HRS(16) + TASK(remainder~57.9)
  const COL={date:38,site:28,in:24,out:24,hrs:16,task:0};
  COL.task=CW-COL.date-COL.site-COL.in-COL.out-COL.hrs;
  const COL_WIDTHS=[COL.date,COL.site,COL.in,COL.out,COL.hrs,COL.task];

  const empIds=Object.keys(empMap);
  const headerColor=isPrelim?AMBER_COL:GREEN;

  empIds.forEach((empId,pageIdx)=>{
    if(pageIdx>0)doc.addPage();
    const emp=empMap[empId];
    const rows=consolidate(emp.punches);
    const allSites=[...emp.sites].sort().join(', ');
    let y=MT;

    // ── HEADER BAND ──
    doc.setFillColor(...headerColor);
    doc.rect(ML,y,CW,12,'F');
    doc.setTextColor(...WHITE);
    doc.setFont('helvetica','bold');
    doc.setFontSize(12);
    doc.text('Panorama Building Systems — PanoramaTrack',ML+3,y+5);
    doc.setFont('helvetica','normal');
    doc.setFontSize(8.5);
    doc.text(`Pay period: ${periodFrom} – ${periodTo}`,ML+3,y+10);
    if(isPrelim){
      doc.setFont('helvetica','bold');doc.setFontSize(7);
      doc.text('⚠ PRELIMINARY — SUBJECT TO REVISION',ML+CW-3,y+6.5,{align:'right'});
    }
    y+=14;

    // ── TIME CARD title ──
    doc.setTextColor(...BLACK);
    doc.setFont('helvetica','bold');
    doc.setFontSize(14);
    doc.text('TIME CARD',PW/2,y+6,{align:'center'});
    y+=11;

    // ── Employee info block — 2 rows ──
    doc.setFontSize(8.5);
    // Row 1: NAME | JOBSITE(S)
    doc.setFont('helvetica','bold');
    doc.text('NAME:',ML,y+3.5);
    doc.setFont('helvetica','normal');
    doc.text(emp.name,ML+16,y+3.5);
    doc.setFont('helvetica','bold');
    doc.text('JOBSITE(S):',ML+CW*0.52,y+3.5);
    doc.setFont('helvetica','normal');
    doc.text(allSites,ML+CW*0.52+24,y+3.5);
    y+=6;
    // Row 2: DEPT | SUPERVISOR
    doc.setFont('helvetica','bold');
    doc.text('DEPARTMENT:',ML,y+3.5);
    doc.setFont('helvetica','normal');
    doc.text(emp.dept||'—',ML+27,y+3.5);
    const supName=activeSup?activeSup.name:'—';
    doc.setFont('helvetica','bold');
    doc.text('SUPERVISOR:',ML+CW*0.52,y+3.5);
    doc.setFont('helvetica','normal');
    doc.text(supName,ML+CW*0.52+25,y+3.5);
    y+=8;

    // ── Divider ──
    doc.setDrawColor(...TAN_DARK);
    doc.setLineWidth(0.4);
    doc.line(ML,y,ML+CW,y);
    y+=3;

    // ── Table header ──
    const ROW_H=6.5;
    doc.setFillColor(...TAN);
    doc.rect(ML,y,CW,ROW_H,'F');
    doc.setDrawColor(...TAN_DARK);
    doc.setLineWidth(0.25);
    let cx=ML;
    COL_WIDTHS.forEach(w=>{cx+=w;if(cx<ML+CW)doc.line(cx,y,cx,y+ROW_H);});
    doc.rect(ML,y,CW,ROW_H);
    doc.setFont('helvetica','bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...BLACK);
    const colLabels=['DATE','JOBSITE','CLOCK IN','CLOCK OUT','HOURS','TASK CODE'];
    let lx=ML;
    COL_WIDTHS.forEach((w,i)=>{
      doc.text(colLabels[i],lx+w/2,y+ROW_H-1.8,{align:'center'});
      lx+=w;
    });
    y+=ROW_H;

    // ── Table rows — variable height for multi-line task codes ──
    doc.setFont('helvetica','normal');
    doc.setFontSize(7.5);
    let totalHrs=0;

    rows.forEach((r,ri)=>{
      // Build task code lines: "41-001 (Interior Steel)"
      const taskLines=r.hasAuto
        ?['Auto-clocked']
        :([...r.acts].map(a=>formatTaskCode(a)));
      if(!taskLines.length)taskLines.push('—');

      // Row height = lines * 4mm + 2mm padding, min ROW_H
      const lineH=4;
      const rH=Math.max(ROW_H, taskLines.length*lineH+2);

      // Check if we'd overflow the page — leave room for total + footnotes + sig
      if(y+rH>PH-50){
        // Add a continuation page
        doc.addPage();
        y=MT;
        // Repeat mini header
        doc.setFillColor(...headerColor);
        doc.rect(ML,y,CW,7,'F');
        doc.setFont('helvetica','bold');doc.setFontSize(8);doc.setTextColor(...WHITE);
        doc.text(`${emp.name} — continued`,ML+3,y+5);
        y+=9;
        // Repeat col headers
        doc.setFillColor(...TAN);
        doc.rect(ML,y,CW,ROW_H,'F');
        doc.setDrawColor(...TAN_DARK);doc.setLineWidth(0.25);
        let cx2=ML;
        COL_WIDTHS.forEach(w=>{cx2+=w;if(cx2<ML+CW)doc.line(cx2,y,cx2,y+ROW_H);});
        doc.rect(ML,y,CW,ROW_H);
        doc.setFont('helvetica','bold');doc.setFontSize(7.5);doc.setTextColor(...BLACK);
        let lx2=ML;
        COL_WIDTHS.forEach((w,i)=>{doc.text(colLabels[i],lx2+w/2,y+ROW_H-1.8,{align:'center'});lx2+=w;});
        y+=ROW_H;
        doc.setFont('helvetica','normal');doc.setFontSize(7.5);
      }

      const rowBg=ri%2===0?WHITE:LGRAY;
      const bgColor=r.hasEstimated?AMBER_BG:rowBg;
      doc.setFillColor(...bgColor);
      doc.rect(ML,y,CW,rH,'F');
      doc.setDrawColor(...TAN_DARK);doc.setLineWidth(0.25);
      let rx=ML;
      COL_WIDTHS.forEach(w=>{rx+=w;if(rx<ML+CW)doc.line(rx,y,rx,y+rH);});
      doc.rect(ML,y,CW,rH);

      const dateStr=r.date.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'});
      const inStr=fmtTime(r.clockIn);
      const outStr=r.clockOut?(fmtTime(r.clockOut)+(r.hasEstimated?' (est.)':'')):'—';
      const hrsStr=r.hrs>0?r.hrs.toFixed(2):'—';
      totalHrs+=r.hrs;

      const textY=y+4; // baseline for first text line
      doc.setTextColor(...(r.hasAuto?RED_TEXT:BLACK));
      let tx=ML;
      // Date
      doc.text((r.hasAuto?'! ':'')+dateStr,tx+2,textY);tx+=COL.date;
      // Jobsite
      doc.setTextColor(...BLACK);
      doc.text(r.jobsite,tx+COL.site/2,textY,{align:'center'});tx+=COL.site;
      // Clock in/out
      doc.text(inStr,tx+COL.in/2,textY,{align:'center'});tx+=COL.in;
      doc.setFont('helvetica',r.hasEstimated?'italic':'normal');
      doc.text(outStr,tx+COL.out/2,textY,{align:'center'});tx+=COL.out;
      doc.setFont('helvetica','normal');
      // Hours
      doc.setFont('helvetica','bold');
      doc.text(hrsStr,tx+COL.hrs-2,textY,{align:'right'});tx+=COL.hrs;
      doc.setFont('helvetica','normal');
      // Task codes — one per line
      taskLines.forEach((line,li)=>{
        doc.text(line,tx+2,textY+li*lineH);
      });
      y+=rH;
    });

    // ── TOTAL row ──
    const TOT_H=7;
    doc.setFillColor(...TAN);
    doc.rect(ML,y,CW,TOT_H,'F');
    doc.setDrawColor(...TAN_DARK);
    doc.rect(ML,y,CW,TOT_H);
    const hrsX=ML+COL.date+COL.site+COL.in+COL.out;
    doc.line(hrsX,y,hrsX,y+TOT_H);
    doc.setFont('helvetica','bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...BLACK);
    doc.text('TOTAL',ML+2,y+TOT_H-2);
    doc.text(totalHrs.toFixed(2),hrsX+COL.hrs-2,y+TOT_H-2,{align:'right'});
    y+=TOT_H+5;

    // ── Footnotes ──
    if(rows.some(r=>r.hasAuto)){
      doc.setFont('helvetica','italic');doc.setFontSize(7);
      doc.setTextColor(...RED_TEXT);
      doc.text('! Records marked ! were auto-clocked out at 12 hours and may require review.',ML,y);
      y+=4.5;doc.setTextColor(...BLACK);
    }

    // ── Preliminary footnote ──
    if(isPrelim&&estimatedOut){
      doc.setFont('helvetica','italic');doc.setFontSize(7);doc.setTextColor(214,123,17);
      doc.text(`Hours marked (est.) are based on an estimated clock-out of ${estimatedOut} provided by the supervisor at time of preliminary submission.`,ML,y);
      y+=5;doc.setTextColor(...BLACK);
    }
    // ── Signature line ──
    const sigY=Math.max(y+10,PH-MT-25);
    doc.setFont('helvetica','normal');
    doc.setFontSize(8);
    doc.setDrawColor(...BLACK);
    doc.setLineWidth(0.3);
    doc.line(ML,sigY,ML+70,sigY);
    doc.text('Supervisor approval',ML,sigY+4);
    doc.line(ML+CW-50,sigY,ML+CW,sigY);
    doc.text('Date',ML+CW-50,sigY+4);
  });

  // ── Save ──
  const f=exportRange.from.toLocaleDateString([],{month:'short',day:'numeric'}).replace(' ','-');
  const t2=exportRange.to.toLocaleDateString([],{month:'short',day:'numeric'}).replace(' ','-');
  const sites=activeSup?(activeSup.jobsites||[]):[];
  const siteName=sites.length===1?sites[0]:'MultiSite';
  const filePrefix=isPrelim?'PRELIMINARY_':'';
  doc.save(`${filePrefix}PanoramaTrack_${siteName.replace(/\s/g,'_')}_${f}_to_${t2}.pdf`);
  // Restore estimated open punches back to null so live view stays accurate
  if(isPrelim){
    (exportRange.logs||[]).forEach(l=>{if(l.estimatedOut){l.out=null;l.estimatedOut=null;}});
  }
  closeConfirmModal();
  const notifMsg=isPrelim?'Preliminary report submitted — remember to submit Final after the holiday':'PDF generated';
  showNotif('✓',notifMsg,`${Object.keys(empMap).length} time card${Object.keys(empMap).length!==1?'s':''} downloaded`,isPrelim?'#c47f17':'#1D9E75',3500);
}

/* ─── Submissions panel (master admin) ─── */
/* ─── MASTER: Submissions panel (v44.0 Build 3 — full rewrite) ────────────────────
   Replaces the old first-submission-wins list (which read the `submissions` table — that
   table is now only used by the supervisor's preview-export duplicate detection, unrelated
   to this panel). This panel reads pt_timecard_status and is organized as jobsite accordions
   with "X of Y submitted" headers, per-employee failsafe flags + admin override, and
   per-site / all-sites export that produces one full consolidated file per employee. */

let _subPeriodMode='current'; // 'current' | 'last' — mirrors the supervisor's period pattern
function subStatusPeriod(){
  return _subPeriodMode==='last'?getPeriodByOffset(1):getPeriodByOffset(0);
}
function setSubPeriod(mode){
  _subPeriodMode=mode;
  ['current','last'].forEach(m=>{
    const btn=document.getElementById('subbtn-'+m);
    if(btn){
      btn.style.fontWeight=m===mode?'700':'500';
      btn.style.background=m===mode?'var(--blue-l)':'';
      btn.style.color=m===mode?'var(--blue-d)':'';
    }
  });
  refreshSubmissionsPanel();
}

// v47.5: click-through for the overview "Ready to Export" tile. Previously always jumped to
// switchMasterTab('submissions'), which opens on whatever _subPeriodMode already happened to be
// (default 'current') — misleading right after rollover, when the ready employees are sitting in
// 'last' and the tile's combined count would land on an empty Current view. refreshMasterOverview
// sets _overviewReadyPrefPeriod each time it runs, so this just steers the period toggle before
// switchMasterTab('submissions') paints it (switchMasterTab calls setSubPeriod(_subPeriodMode) for
// the 'submissions' tab, so setting _subPeriodMode here is picked up automatically).
function goToReadyExports(){
  if(_overviewReadyPrefPeriod==='last')_subPeriodMode='last';
  switchMasterTab('submissions');
}

/* ─── Admin correction modal (v46.0) ───────────────────────────────────────────
   Tap any employee's name in the Submissions panel to view/edit their punches inline —
   covers the case where a timecard reached sup_submitted without genuine back-and-forth
   review (Force Submit, Admin Override) and admin/GM needs the final look, but works for
   any employee row, not just those. Shows punches across every site they worked in the
   period currently in view (matches how the row's hours total already spans all sites).
   Reuses the existing shared edit-punch modal (openEditModal/openAddPunchModal) rather
   than a separate editor — see saveEdit()/deletePunch()'s refresh hooks for the tie-back. */
async function openAdminEmpCorrect(empId,empName){
  _adminCorrectEmpId=empId;
  _adminCorrectEmpName=empName;
  document.getElementById('admin-correct-name').textContent=empName;
  document.getElementById('admin-correct-list').innerHTML='<p style="text-align:center;color:var(--txt2);padding:20px;font-size:13px;">Loading…</p>';
  document.getElementById('admin-correct-modal-bg').style.display='flex';
  await refreshAdminEmpCorrect();
}

async function refreshAdminEmpCorrect(){
  if(!_adminCorrectEmpId)return;
  const period=subStatusPeriod(); // same Current/Last toggle as the panel underneath
  document.getElementById('admin-correct-period').textContent=
    `${period.start.toLocaleDateString([],{month:'short',day:'numeric'})} – ${period.end.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;
  // v47.6: also fetch this employee's status rows so out-of-submission can be checked per punch
  // (needs each punch's own jobsite's row — same helper the My Timecard panel uses).
  const [punchRes,statusRows]=await Promise.all([
    sb.from('punches').select('*')
      .eq('employee_id',_adminCorrectEmpId)
      .gte('clock_in',period.start.toISOString())
      .lte('clock_in',period.end.toISOString())
      .order('clock_in',{ascending:false}),
    getEmployeeStatusRows(_adminCorrectEmpId,period.start)
  ]);
  const {data,error}=punchRes;
  const list=document.getElementById('admin-correct-list');
  if(error){list.innerHTML='<p style="text-align:center;color:var(--red);padding:20px;font-size:13px;">Could not load punches — check connection.</p>';return;}
  const entries=(data||[]).map(dbRowToEntry);
  if(!entries.length){list.innerHTML='<p style="text-align:center;color:var(--txt2);padding:20px;font-size:13px;">No punches recorded for this period.</p>';return;}
  // v47.6: per-punch flags — the same three categories the Submissions panel already rolls up
  // into the employee-level "⚠️ ..." summary one screen up, surfaced per punch here so the admin
  // can see exactly which record needs attention instead of opening each one to check.
  list.innerHTML=entries.map(e=>{
    const hrs=paidHours(e);
    const row=statusRows.find(r=>r.jobsite===e.jobsite)||null;
    const autoFlag=e.autoClocked&&!e.editedAfterAuto;
    const waiveFlag=isPendingWaive(e);
    const oosFlag=isOutOfSubmission(e,row);
    const flagged=autoFlag||waiveFlag||oosFlag;
    const flagParts=[];
    if(autoFlag)flagParts.push('Unresolved auto-clock');
    if(waiveFlag)flagParts.push('Pending lunch waive');
    if(oosFlag)flagParts.push('Punch after submit');
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 4px;border-bottom:0.5px solid var(--bdr);gap:8px;flex-wrap:wrap;">
      <div style="min-width:0;">
        <span style="font-size:13px;color:var(--txt);font-weight:600;">${e.jobsite||'—'}</span>
        <div style="font-size:11px;color:var(--txt2);margin-top:2px;">${fmtDt(e.in)} – ${e.out?fmtDt(e.out):'still clocked in'}</div>
        ${flagged?`<div style="font-size:11px;color:var(--red);margin-top:2px;">⚠️ ${flagParts.join(' · ')}</div>`:''}
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
        <span style="font-size:12px;color:${flagged?'var(--red)':'var(--txt2)'};font-weight:${flagged?'700':'400'};">${hrs!=null?hrs.toFixed(2)+'h':'—'}</span>
        <button class="btn-sm" onclick="openEditModal('db:${e.dbId}')" style="background:var(--bg2);color:var(--txt);border:0.5px solid var(--bdr2);">Edit</button>
      </div>
    </div>`;
  }).join('');
}

function closeAdminEmpCorrect(){
  document.getElementById('admin-correct-modal-bg').style.display='none';
  _adminCorrectEmpId=null;_adminCorrectEmpName=null;
}

async function refreshSubmissionsPanel(){
  const container=document.getElementById('submissions-list');
  container.innerHTML='<p style="color:var(--txt2);font-size:13px;padding:12px 0;">Loading…</p>';
  const period=subStatusPeriod();
  const periodLabel=`${period.start.toLocaleDateString([],{month:'short',day:'numeric'})} – ${period.end.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;
  const lbl=document.getElementById('sub-period-label');if(lbl)lbl.textContent=periodLabel;

  const [statusMap,punchRes]=await Promise.all([
    getAllStatusForPeriod(period.start),
    sb.from('punches').select('*').gte('clock_in',period.start.toISOString()).lte('clock_in',period.end.toISOString())
  ]);
  if(punchRes.error){container.innerHTML='<p style="color:var(--red);">Error loading punches: '+punchRes.error.message+'</p>';return;}
  const allPunches=(punchRes.data||[]).map(dbRowToEntry);

  // Group punches by employee (all sites — for the total-hours figure) and by employee+jobsite
  // (for that row's failsafe flags), and track which jobsites each employee actually worked
  // (needed so isFullyReadyForExport can catch a worked site with NO row yet, not just check
  // the rows that happen to exist).
  const punchesByEmp={},punchesByEmpSite={},sitesWorkedByEmp={};
  allPunches.forEach(p=>{
    if(!p.empId)return;
    (punchesByEmp[p.empId]=punchesByEmp[p.empId]||[]).push(p);
    (punchesByEmpSite[p.empId+'|'+p.jobsite]=punchesByEmpSite[p.empId+'|'+p.jobsite]||[]).push(p);
    (sitesWorkedByEmp[p.empId]=sitesWorkedByEmp[p.empId]||new Set()).add(p.jobsite);
  });

  // Jobsite → set of employee IDs. v47.2: only includes employees who have actual
  // current-period punches at that site. Previously this was the union of "who punched
  // there" ∪ "who has a status row there" — which meant stale rows (e.g. left over after
  // an employee removed their punches following an admin/supervisor send-back) rendered
  // as "Never submitted" rows for sites the employee doesn't work at anymore. Filtering
  // to punch presence kills that display artifact AND the matching "waiting on:" note
  // in the blockingSites calc below.
  const siteEmpSet={};
  const addToSite=(site,empId)=>{if(!site)return;(siteEmpSet[site]=siteEmpSet[site]||new Set()).add(String(empId));};
  allPunches.forEach(p=>addToSite(p.jobsite,p.empId));
  const sitesOrdered=[...new Set([...JOBSITES.filter(j=>siteEmpSet[j]),...Object.keys(siteEmpSet).filter(j=>!JOBSITES.includes(j))])];

  const empNameById={};(employees||[]).forEach(e=>{empNameById[e.id]=e.name;});
  const now=new Date();
  const periodEnded=_subPeriodMode==='last'||now>=period.end;
  let anyFullyReadyAnywhere=false;

  const accordionHtml=sitesOrdered.map(site=>{
    const empIds=[...siteEmpSet[site]].sort((a,b)=>(empNameById[a]||'').localeCompare(empNameById[b]||''));
    let readyCount=0,canExportSite=false;
    const rowsHtml=empIds.map(empId=>{
      const rows=statusMap[empId]||[];
      const row=rows.find(r=>r.jobsite===site)||null;
      const stage=stageOf(row);
      const ready=stageAtLeast(stage,TC_STAGE.SUP);
      if(ready)readyCount++;
      const exported=stage===TC_STAGE.EXPORTED;
      const fullyReady=isFullyReadyForExport(rows,[...(sitesWorkedByEmp[empId]||[])]);
      if(fullyReady){anyFullyReadyAnywhere=true;if(ready)canExportSite=true;}
      const name=empNameById[empId]||`Employee #${empId}`;
      const totalHrs=(punchesByEmp[empId]||[]).reduce((s,p)=>s+(paidHours(p)||0),0);
      const sitePunches=punchesByEmpSite[empId+'|'+site]||[];
      const oosCount=sitePunches.filter(p=>isOutOfSubmission(p,row)).length;
      const autoCount=sitePunches.filter(p=>p.autoClocked&&!p.editedAfterAuto).length;
      const waiveCount=sitePunches.filter(p=>isPendingWaive(p)).length;
      const neverSubmitted=stage===TC_STAGE.OPEN&&periodEnded;
      const stuckEmp=stage===TC_STAGE.EMP;

      // v47.2: cross-site blocker note — this site's row is done, but the employee worked
      // another site that isn't at sup_submitted+ yet. Only counts sites where the employee
      // has actual current-period punches (was previously union of sitesWorkedByEmp AND
      // status-row jobsites — stale rows for sites the employee no longer works at could
      // pollute the waiting-on list). The panel-level filter above now also prevents stale
      // sites from rendering, so this is belt-and-suspenders — safe against future paths
      // that might reintroduce orphan rows.
      let blockingSites=[];
      if(ready){
        const otherSites=new Set(sitesWorkedByEmp[empId]||[]);
        otherSites.delete(site);
        blockingSites=[...otherSites].filter(s=>{
          const r=rows.find(rr=>rr.jobsite===s);
          return !stageAtLeast(r?r.stage:TC_STAGE.OPEN,TC_STAGE.SUP);
        });
      }

      const flagParts=[];
      if(neverSubmitted)flagParts.push('Never submitted');
      if(stuckEmp)flagParts.push('Needs supervisor review');
      // v47.1: "Waiting on:" no longer in flagParts — moved inline beside ✓ in statusHtml
      if(oosCount)flagParts.push(`${oosCount} punch${oosCount!==1?'es':''} after submit`);
      if(autoCount)flagParts.push(`${autoCount} unresolved auto-clock${autoCount!==1?'s':''}`);
      if(waiveCount)flagParts.push(`${waiveCount} pending waive${waiveCount!==1?'s':''}`);
      const hasFlag=flagParts.length>0;
      const blocked=autoCount>0||waiveCount>0;
      const canOverride=(neverSubmitted||stuckEmp)&&!blocked;

      let actionHtml='';
      if(!ready&&canOverride){
        actionHtml=`<button class="btn-sm" onclick="event.stopPropagation();adminOverrideSite('${empId}','${site.replace(/'/g,"\\'")}','${name.replace(/'/g,"\\'")}')" style="background:var(--amber-l);color:var(--amber);border:0.5px solid var(--amber);margin-left:6px;">Override</button>`;
      } else if(!ready&&blocked){
        actionHtml=`<span style="font-size:10px;color:var(--txt3);margin-left:6px;">Fix punches first</span>`;
      }
      // v47.0: admin send-back button for exported employees — returns to sup_submitted
      if(exported&&!actionHtml){
        actionHtml=`<button class="btn-sm" onclick="event.stopPropagation();adminSendBack('${empId}','${site.replace(/'/g,"\\'")}','${name.replace(/'/g,"\\'")}')" style="background:var(--bg2);color:var(--txt2);border:0.5px solid var(--bdr2);margin-left:6px;">Send back</button>`;
      }
      // v47.1: blocking-sites note rendered inline beside ✓ (subtle gray, so it reads
      // as informational rather than as a warning)
      const blockingNote=blockingSites.length
        ? `<span style="font-size:11px;color:var(--txt3);margin-left:6px;font-weight:400;">waiting on: ${blockingSites.join(', ')}</span>`
        : '';
      const statusHtml=exported
        ? '<span class="badge" style="background:var(--blue-l,#dbeafe);color:var(--blue-d,#1e40af);font-size:10px;margin-left:6px;">✓ Exported</span>'
        : ready?`<span style="color:var(--green);font-weight:700;margin-left:6px;">✓</span>${blockingNote}`:'';

      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 4px;border-bottom:0.5px solid var(--bdr);gap:8px;flex-wrap:wrap;">
        <div style="min-width:0;">
          <span onclick="openAdminEmpCorrect('${empId}','${name.replace(/'/g,"\\'")}')" style="font-size:13px;color:var(--blue-d);font-weight:600;cursor:pointer;text-decoration:underline;text-decoration-color:var(--bdr2);">${name}</span>${statusHtml}
          ${hasFlag?`<div style="font-size:11px;color:${blocked?'#e07070':'var(--amber)'};margin-top:2px;">⚠️ ${flagParts.join(' · ')}</div>`:''}
        </div>
        <div style="display:flex;align-items:center;flex-shrink:0;">
          <span style="font-size:13px;font-weight:600;color:var(--txt);">${totalHrs.toFixed(1)}h</span>
          ${actionHtml}
        </div>
      </div>`;
    }).join('');

    const cardId=`sub-site-${site.replace(/[^a-zA-Z0-9]/g,'_')}`;
    return `<div class="emp-card">
      <div class="emp-card-header" onclick="toggleEmpCard('${cardId}')">
        <div>
          <p style="font-size:14px;font-weight:600;color:var(--txt);margin:0;">${site}</p>
          <p class="emp-summary">${readyCount} of ${empIds.length} submitted</p>
        </div>
        <span style="font-size:18px;color:var(--txt3);" id="${cardId}-chevron">▸</span>
      </div>
      <div class="emp-card-body" id="${cardId}">
        ${rowsHtml||'<p style="color:var(--txt2);font-size:12px;padding:8px 4px;">No employees this period.</p>'}
        <div style="padding:10px 4px 2px;">
          <button class="btn-sm" onclick="openSubmissionsExport('site','${site.replace(/'/g,"\\'")}')">${canExportSite?`Export ${site} →`:'Nothing to export — details'}</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // v44.3: top button is never disabled — always clickable. Label swaps to signal state;
  // click routes to openSubmissionsExport('all',null), which shows the breakdown popup
  // when nothing is eligible (instead of the old silent-fail disabled state).
  const topExportBtn=document.getElementById('sub-export-all-btn');
  if(topExportBtn){
    topExportBtn.disabled=false;
    topExportBtn.textContent=anyFullyReadyAnywhere?'Export all sites (ready employees) →':'Nothing to export — details';
  }

  container.innerHTML=accordionHtml||'<p style="color:var(--txt2);text-align:center;padding:20px;font-size:13px;">No punch records for this period.</p>';
}

/* Admin override (v44.0 Build 3): forces a flagged employee's THIS-SITE row straight to
   sup_submitted — standing in for BOTH the employee's submission and the supervisor's review,
   for when neither is available to act. Same clean-punches gate as Force Submit. No audit
   marker is kept — once overridden it's indistinguishable from a normal supervisor submit. */
async function adminOverrideSite(empId,jobsite,empName){
  const period=subStatusPeriod();
  const {data,error}=await sb.from('punches').select('*')
    .eq('employee_id',empId).eq('jobsite',jobsite)
    .gte('clock_in',period.start.toISOString()).lte('clock_in',period.end.toISOString());
  if(error){showCustomAlert('Error','Could not load punches: '+error.message);return;}
  const punches=(data||[]).map(dbRowToEntry);
  const autos=punches.filter(p=>p.autoClocked&&!p.editedAfterAuto);
  const waives=punches.filter(p=>isPendingWaive(p));
  if(autos.length||waives.length){
    const parts=[];
    if(autos.length)parts.push(`${autos.length} unresolved auto-clock-out${autos.length!==1?'s':''}`);
    if(waives.length)parts.push(`${waives.length} pending lunch waive${waives.length!==1?'s':''}`);
    showCustomAlert('Fix these first',`${empName} has ${parts.join(' and ')} at ${jobsite}. Resolve via Edit before overriding.`);
    return;
  }
  showCustomConfirm(
    `Override for ${empName} at ${jobsite}?`,
    `This marks ${empName}'s timecard at ${jobsite} as ready for export — standing in for both the employee's submission and the supervisor's review. Use this only when neither is available.`,
    'Double-check the hours above before overriding.',
    'Override','var(--amber)',
    async()=>{
      const {ok,error:err}=await setTimecardStage(empId,period,TC_STAGE.SUP,jobsite);
      if(!ok){showCustomAlert('Could not override','There was a problem: '+(err?.message||'unknown error'));return;}
      showNotif('✓','Overridden',`${empName} at ${jobsite} is ready for export`,'#c47f17',2600);
      refreshSubmissionsPanel();
    });
}

/* ─── Admin: Send back an exported timecard (v47.0, revised v47.2) ─────────────
   Returns an exported employee's site row from 'exported' → 'open'. Originally v47.0
   sent back to 'sup_submitted', but that reads as "sent to office" on the supervisor's
   card — no visual change, no signal to the supervisor that anything happened. Sending
   to 'open' gives the supervisor the "not submitted" chip + Force Submit button, so
   they can review/correct/force-submit without needing the employee to be involved
   (useful for departed employees). If the supervisor decides the employee should redo
   it, they can use their own Send Back action to notify the employee. */
async function adminSendBack(empId,jobsite,empName){
  const period=subStatusPeriod();
  showCustomConfirm(
    `Send back ${empName} at ${jobsite}?`,
    `This returns the exported timecard to the supervisor as not-yet-submitted. The supervisor can then review, edit punches, and Force Submit to re-send to office — or forward it back to the employee for changes. You\u2019ll need to re-export after any corrections.`,
    '',
    'Send back to supervisor','var(--amber)',
    async()=>{
      const {ok,error}=await setTimecardStage(empId,period,TC_STAGE.OPEN,jobsite);
      if(!ok){showCustomAlert('Could not send back','There was a problem: '+(error?.message||'unknown error'));return;}
      showNotif('✓','Sent back',`${empName} at ${jobsite} returned to supervisor`,'#c47f17',2600);
      refreshSubmissionsPanel();
    });
}

/* Export (v44.0 Build 3): only includes employees who are sup_submitted at EVERY jobsite they
   worked this period (isFullyReadyForExport). Generates ONE full consolidated file per employee
   — all hours, all sites, same as the existing template — then stamps stage='exported' on every
   one of their site-rows at once, so they drop out of every accordion together. Reuses the
   existing PDF/Excel machinery by pointing _masterLogs + the Report tab's date fields at this
   scoped set (see _pendingExportStampFn's comment for why that's necessary), then routes through
   the same format picker used by the Report tab. */
async function openSubmissionsExport(scopeType,jobsite){
  const period=subStatusPeriod();
  const [statusMap,punchRes]=await Promise.all([
    getAllStatusForPeriod(period.start),
    sb.from('punches').select('*').gte('clock_in',period.start.toISOString()).lte('clock_in',period.end.toISOString())
  ]);
  if(punchRes.error){showCustomAlert('Error','Could not load punches: '+punchRes.error.message);return;}
  const allLogs=(punchRes.data||[]).map(dbRowToEntry);
  const sitesWorkedByEmp={};
  allLogs.forEach(p=>{if(!p.empId)return;(sitesWorkedByEmp[p.empId]=sitesWorkedByEmp[p.empId]||new Set()).add(p.jobsite);});

  let eligibleIds=Object.keys(statusMap).filter(id=>isFullyReadyForExport(statusMap[id],[...(sitesWorkedByEmp[id]||[])]));
  if(scopeType==='site')eligibleIds=eligibleIds.filter(id=>(statusMap[id]||[]).some(r=>r.jobsite===jobsite&&r.stage===TC_STAGE.SUP));
  if(!eligibleIds.length){
    // v44.3: instead of a flat "Nothing ready" alert, show a state-aware breakdown popup
    // with counts (fully exported / not yet submitted / partially exported) and a
    // conditional Re-export button when any employees are already exported.
    showExportEmptyBreakdown(scopeType,jobsite,statusMap,allLogs,sitesWorkedByEmp,period);
    return;
  }

  const logs=allLogs.filter(l=>eligibleIds.includes(String(l.empId)));
  if(!logs.length){showCustomAlert('No data','No completed punches found for the ready employees.');return;}

  _masterLogs=logs;
  masterExportRange={logs};
  document.getElementById('m-log-from').value=toDateStr(period.start);
  document.getElementById('m-log-to').value=toDateStr(period.end);

  _pendingExportStampFn=async()=>{
    const pairs=[];
    eligibleIds.forEach(id=>{(statusMap[id]||[]).forEach(r=>pairs.push({empId:id,jobsite:r.jobsite}));});
    await Promise.all(pairs.map(p=>setTimecardStage(p.empId,period,TC_STAGE.EXPORTED,p.jobsite)));
    refreshSubmissionsPanel();
  };
  showMasterFormatModal();
}

/* ─── v44.3: Export breakdown popup + re-export path ────────────────────────────

   The admin Submissions panel used to silently disable the "Export all sites" and
   per-site export buttons when nothing was eligible for export — no feedback, and no
   way to re-export employees already exported this period. v44.3 replaces that with:

     1. Buttons stay clickable at all times (label swaps to "Nothing to export — details"
        when nothing is eligible, courtesy of refreshSubmissionsPanel).
     2. openSubmissionsExport routes to showExportEmptyBreakdown() when it finds no
        eligible IDs — a state-aware popup with counts (no names) and a conditional
        Re-export button.
     3. Re-export runs the same file-generation path as the initial export but stamps
        no stages (the rows are already 'exported'), so the panel view is unchanged
        after re-export finishes.

   Wording softener (v44.3, "option 2"): when viewing the CURRENT period, mid-period
   supervisors haven't had a chance to submit yet — so we say "not yet submitted
   (period still open)" instead of the sharper "waiting on supervisor submission",
   which is reserved for the LAST-period view where a delay actually matters. */

let _ebReExportCb=null;
function showExportBreakdown(title,bodyHtml,reExportLabel,onReExport){
  document.getElementById('eb-title').textContent=title;
  document.getElementById('eb-body').innerHTML=bodyHtml;
  const btn=document.getElementById('eb-reexport-btn');
  if(reExportLabel&&onReExport){
    btn.textContent=reExportLabel;
    btn.style.display='';
    _ebReExportCb=onReExport;
  } else {
    btn.style.display='none';
    _ebReExportCb=null;
  }
  document.getElementById('export-breakdown-bg').style.display='flex';
}
function closeExportBreakdown(){
  document.getElementById('export-breakdown-bg').style.display='none';
  _ebReExportCb=null;
}
function doExportBreakdownReExport(){
  const cb=_ebReExportCb;
  closeExportBreakdown();
  if(cb)cb();
}
// Wire the Re-export button once the DOM is ready.
document.addEventListener('DOMContentLoaded',()=>{
  const b=document.getElementById('eb-reexport-btn');
  if(b)b.addEventListener('click',doExportBreakdownReExport);
});

/* Compute state buckets for the empty-export popup, then show it.
   Buckets (using the same "worked sites" definition as isFullyReadyForExport — union of
   sites the employee punched at AND sites where a status row exists):
     - fullyExported:     every worked site at stage='exported'
     - partiallyExported: some sites at 'exported', others below (rare edge case — new
                          punch at a new site after export; usually 0)
     - notSubmitted:      no sites at 'exported' AND not fully at 'sup_submitted' either
                          (covers open/emp_submitted/mixed-below-sup states)
   For per-site scope, only counts employees who touched that specific jobsite. */
function showExportEmptyBreakdown(scopeType,jobsite,statusMap,allLogs,sitesWorkedByEmp,period){
  const empIds=Object.keys(statusMap);
  const punchEmpIds=Object.keys(sitesWorkedByEmp);
  const allEmpIds=[...new Set([...empIds,...punchEmpIds])];

  // For per-site scope: only count employees who touched this site (either punched
  // there or have a status row for it — the same union used across the panel).
  const scoped=scopeType==='site'
    ? allEmpIds.filter(id=>{
        const worked=sitesWorkedByEmp[id];
        const hasRow=(statusMap[id]||[]).some(r=>r.jobsite===jobsite);
        return (worked&&worked.has(jobsite))||hasRow;
      })
    : allEmpIds;

  let fullyExported=0,partiallyExported=0,notSubmitted=0;
  scoped.forEach(id=>{
    const rows=statusMap[id]||[];
    const worked=[...(sitesWorkedByEmp[id]||[])];
    const sites=new Set([...worked,...rows.map(r=>r.jobsite)]);
    if(!sites.size)return;
    const stages=[...sites].map(s=>{
      const r=rows.find(rr=>rr.jobsite===s);
      return r?r.stage:TC_STAGE.OPEN;
    });
    const allEx=stages.every(st=>st===TC_STAGE.EXPORTED);
    const anyEx=stages.some(st=>st===TC_STAGE.EXPORTED);
    if(allEx)fullyExported++;
    else if(anyEx)partiallyExported++;
    else notSubmitted++;
  });

  const isCurrent=_subPeriodMode==='current';
  const notSubmittedLabel=isCurrent
    ? 'not yet submitted (period still open)'
    : 'waiting on supervisor submission';

  const title=scopeType==='site'?`Nothing to export at ${jobsite}`:'Nothing to export';

  const lines=[];
  if(fullyExported>0)lines.push(`<strong>${fullyExported}</strong> employee${fullyExported!==1?'s':''} already fully exported this period`);
  if(notSubmitted>0)lines.push(`<strong>${notSubmitted}</strong> employee${notSubmitted!==1?'s':''} ${notSubmittedLabel}`);
  if(partiallyExported>0)lines.push(`<strong>${partiallyExported}</strong> employee${partiallyExported!==1?'s':''} partially exported`);

  const bodyHtml=lines.length
    ? '<ul style="margin:6px 0 0;padding-left:20px;color:var(--txt);font-size:13px;line-height:1.7;">'+lines.map(l=>`<li>${l}</li>`).join('')+'</ul>'
    : '<p style="color:var(--txt2);font-size:13px;margin:0;">No employees with punches this period.</p>';

  const canReExport=fullyExported>0;
  const reExportLabel=canReExport
    ? `Re-export ${fullyExported} already-exported employee${fullyExported!==1?'s':''}`
    : null;
  const onReExport=canReExport
    ? ()=>startReExport(scopeType,jobsite,statusMap,allLogs,sitesWorkedByEmp,period)
    : null;

  showExportBreakdown(title,bodyHtml,reExportLabel,onReExport);
}

/* Re-export path — regenerates the same consolidated file(s) for employees whose every
   worked site is already at stage='exported'. No stage stamping (they're already
   exported); the no-op _pendingExportStampFn still refreshes the panel afterwards for
   consistency. For per-site scope, further filtered to employees who worked that site. */
function startReExport(scopeType,jobsite,statusMap,allLogs,sitesWorkedByEmp,period){
  let reExportIds=Object.keys(statusMap).filter(id=>{
    const rows=statusMap[id]||[];
    const worked=[...(sitesWorkedByEmp[id]||[])];
    const sites=new Set([...worked,...rows.map(r=>r.jobsite)]);
    if(!sites.size)return false;
    return [...sites].every(s=>{
      const r=rows.find(rr=>rr.jobsite===s);
      return !!r&&r.stage===TC_STAGE.EXPORTED;
    });
  });
  if(scopeType==='site')reExportIds=reExportIds.filter(id=>{
    const worked=sitesWorkedByEmp[id];
    return worked&&worked.has(jobsite);
  });

  if(!reExportIds.length){
    showCustomAlert('Nothing to re-export','No fully-exported employees found for this scope.');
    return;
  }

  const logs=allLogs.filter(l=>reExportIds.includes(String(l.empId)));
  if(!logs.length){showCustomAlert('No data','No punches found for the exported employees.');return;}

  _masterLogs=logs;
  masterExportRange={logs};
  document.getElementById('m-log-from').value=toDateStr(period.start);
  document.getElementById('m-log-to').value=toDateStr(period.end);

  // v44.3: no stage-stamping on re-export — rows are already 'exported'. The stamp
  // function still refreshes the panel so any concurrent-tab changes show through.
  _pendingExportStampFn=async()=>{refreshSubmissionsPanel();};
  showMasterFormatModal();
}

/* ─── Preliminary reminder banner ─── */
/* ─── Database backup ─── */
async function runBackup(){
  const btn=document.getElementById('backup-btn');
  const status=document.getElementById('backup-status');
  btn.disabled=true;btn.textContent='Backing up…';status.textContent='';
  try{
    const tables={};
    const steps=[
      {key:'employees',   query:()=>sb.from('employees').select('*').order('name')},
      {key:'jobsites',    query:()=>sb.from('jobsites').select('*').order('name')},
      {key:'departments', query:()=>sb.from('departments').select('*').order('name')},
      {key:'activities',  query:()=>sb.from('activities').select('*').order('name')},
      {key:'punches',     query:()=>sb.from('punches').select('*').gte('clock_in',new Date(Date.now()-90*24*60*60*1000).toISOString()).order('clock_in',{ascending:false})},
    ];
    for(const step of steps){
      status.textContent=`Fetching ${step.key}…`;
      const {data,error}=await step.query();
      if(error)throw new Error(`${step.key}: ${error.message}`);
      tables[step.key]=data||[];
    }
    const payload={backed_up_at:new Date().toISOString(),app_version:'v47.4',tables};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    const stamp=new Date().toISOString().slice(0,10);
    a.href=url;a.download=`PanoramaTrack_Backup_${stamp}.json`;
    document.body.appendChild(a);a.click();
    document.body.removeChild(a);URL.revokeObjectURL(url);
    const total=Object.values(tables).reduce((s,t)=>s+t.length,0);
    status.textContent=`✓ Done — ${total} records across ${steps.length} tables`;
    status.style.color='var(--green)';
  }catch(e){
    status.textContent='Error: '+e.message;
    status.style.color='var(--red)';
  }finally{
    btn.disabled=false;btn.textContent='Download backup';
  }
}

function checkPrelimReminder(){
  const stored=sessionStorage.getItem('prelim_reminder');
  if(!stored||!activeSup)return;
  try{
    const r=JSON.parse(stored);
    if(r.supId!==activeSup.id)return;
    // Show banner
    const banner=document.getElementById('prelim-banner');
    const text=document.getElementById('prelim-banner-text');
    if(banner&&text){
      text.innerHTML=`<b>⚠ Preliminary report pending final review</b><br>You submitted a preliminary report for ${r.period} on ${new Date(r.submittedAt).toLocaleDateString([],{month:'short',day:'numeric'})}. Please review any post-holiday punches and submit the Final report.`;
      banner.style.display='block';
    }
  } catch(e){}
}
function dismissPrelimBanner(){
  sessionStorage.removeItem('prelim_reminder');
  const banner=document.getElementById('prelim-banner');
  if(banner)banner.style.display='none';
}

/* ─── App boot ─── */

/* ─── Session persistence across refresh (8 hour window) ─── */
const SESSION_PERSIST_MS = 8 * 60 * 60 * 1000;
function tryRestoreSession(){
  try{
    const raw=localStorage.getItem('pt_session');
    if(!raw)return;
    const s=JSON.parse(raw);
    if(!s||!s.ts)return;
    if(Date.now()-s.ts>SESSION_PERSIST_MS){localStorage.removeItem('pt_session');return;}
    if(s.type==='master'){
      startMasterTimeout();
      showScreen('screen-master');switchMasterTab('overview');
    } else if(s.type==='sup'&&s.supId){
      const sup=supervisors.find(sv=>sv.id===s.supId);
      if(!sup){localStorage.removeItem('pt_session');return;}
      activeSup={...sup,jobsites:sup.jobsites||[]};
      activeSup.activeSite=activeSup.jobsites[0]||null;
      document.getElementById('sup-dash-title').textContent=sup.name;
      const siteLabel=activeSup.jobsites.length>1?activeSup.jobsites.join(' · '):(activeSup.jobsites[0]||'No sites assigned');
      document.getElementById('sup-dash-site').textContent='Supervising: '+siteLabel;
      startSupTimeout();
      showScreen('screen-sup');switchSupTab('live');
    }
  }catch(e){localStorage.removeItem('pt_session');}
}


/* ─── Supervisor inactivity timeout (15 min) ─── */
const SUP_TIMEOUT_MS = 15 * 60 * 1000;
const SUP_WARN_MS    = 14 * 60 * 1000;
let supTimeoutTimer=null;
let supWarnTimer=null;

function resetSupTimer(){
  clearTimeout(supTimeoutTimer);clearTimeout(supWarnTimer);
  document.getElementById('timeout-bar').style.display='none';
  // Refresh session timestamp so 8-hour window resets on activity
  try{const s=JSON.parse(localStorage.getItem('pt_session')||'{}');if(s.type)localStorage.setItem('pt_session',JSON.stringify({...s,ts:Date.now()}));}catch(e){}
  supWarnTimer=setTimeout(()=>{
    document.getElementById('timeout-bar').style.display='block';
  },SUP_WARN_MS);
  supTimeoutTimer=setTimeout(()=>{
    document.getElementById('timeout-bar').style.display='none';
    activeSup=null;
    localStorage.removeItem('pt_session');
    showKiosk();
    showNotif('!','Session expired','You have been logged out due to inactivity','#854F0B',3000);
  },SUP_TIMEOUT_MS);
}

function startSupTimeout(){
  ['click','touchstart','keydown'].forEach(ev=>{
    document.addEventListener(ev,resetSupTimer,{passive:true});
  });
  resetSupTimer();
}
function stopSupTimeout(){
  clearTimeout(supTimeoutTimer);clearTimeout(supWarnTimer);
  document.getElementById('timeout-bar').style.display='none';
  ['click','touchstart','keydown'].forEach(ev=>{
    document.removeEventListener(ev,resetSupTimer);
  });
}

/* ─── Master inactivity timeout (20 min) ─── */
const MASTER_TIMEOUT_MS = 20 * 60 * 1000;
const MASTER_WARN_MS    = 19 * 60 * 1000;
let masterTimeoutTimer=null;
let masterWarnTimer=null;

function resetMasterTimer(){
  clearTimeout(masterTimeoutTimer);clearTimeout(masterWarnTimer);
  document.getElementById('timeout-bar').style.display='none';
  // Refresh session timestamp so 8-hour window resets on activity
  try{const s=JSON.parse(localStorage.getItem('pt_session')||'{}');if(s.type)localStorage.setItem('pt_session',JSON.stringify({...s,ts:Date.now()}));}catch(e){}
  masterWarnTimer=setTimeout(()=>{
    document.getElementById('timeout-bar').style.display='block';
  },MASTER_WARN_MS);
  masterTimeoutTimer=setTimeout(()=>{
    document.getElementById('timeout-bar').style.display='none';
    localStorage.removeItem('pt_session');
    showKiosk();
    showNotif('!','Session expired','Master admin session timed out','#854F0B',3000);
  },MASTER_TIMEOUT_MS);
}
function startMasterTimeout(){
  ['click','touchstart','keydown'].forEach(ev=>{
    document.addEventListener(ev,resetMasterTimer,{passive:true});
  });
  resetMasterTimer();
}
function stopMasterTimeout(){
  clearTimeout(masterTimeoutTimer);clearTimeout(masterWarnTimer);
  document.getElementById('timeout-bar').style.display='none';
  ['click','touchstart','keydown'].forEach(ev=>{
    document.removeEventListener(ev,resetMasterTimer);
  });
}

window.addEventListener('load',()=>bootApp().catch(e=>{
  console.error('Boot failed:',e);
  showDbError('Boot failed: '+e.message);
}));

/* ─── Add to Home Screen (A2HS) ─── */
let deferredA2HS=null;
window.addEventListener('beforeinstallprompt',e=>{
  e.preventDefault();deferredA2HS=e;
  const dismissed=sessionStorage.getItem('a2hs-dismissed');
  if(!dismissed)document.getElementById('a2hs-banner').style.display='flex';
});
window.addEventListener('appinstalled',()=>{
  document.getElementById('a2hs-banner').style.display='none';
});
function doA2HS(){
  if(deferredA2HS){
    deferredA2HS.prompt();
    deferredA2HS.userChoice.then(()=>{deferredA2HS=null;});
  } else {
    // iOS fallback instructions
    showCustomAlert('Add to Home Screen','iPhone/iPad: tap the Share button (box with arrow) then "Add to Home Screen"\n\nAndroid: tap the menu (⋮) then "Add to Home Screen"');
  }
  document.getElementById('a2hs-banner').style.display='none';
}
function dismissA2HS(){
  sessionStorage.setItem('a2hs-dismissed','1');
  document.getElementById('a2hs-banner').style.display='none';
}
// Also show banner manually if not installed and not dismissed, after 4s
setTimeout(()=>{
  const isStandalone=window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone;
  if(!isStandalone&&!deferredA2HS&&!sessionStorage.getItem('a2hs-dismissed')){
    document.getElementById('a2hs-banner').style.display='flex';
  }
},4000);

