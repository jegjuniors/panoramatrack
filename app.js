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
let timeLog=[];      // active punches only cached in memory for speed
let currentPin='';
let pendingClockOut=null;
let selectedActs=new Set();
let editingIdx=null; // index into timeLog array
let editActs=new Set();
let editingSupId=null;
let editingEmpId=null;
let activeSup=null;
let exportRange={from:null,to:null};
let empModalContext='master';
let ARCHIVED_JOBSITES=[];

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
    editedAfterAuto:r.edited_after_auto||false
  };
}

/* ─── Auto clock-out: check open punches server-side ─── */
async function checkAutoServer(){
  const now=new Date();
  const stale=timeLog.filter(e=>!e.out&&(now-e.in)/3600000>=AUTO_H);
  for(const e of stale){
    const autoOut=new Date(e.in.getTime()+AUTO_H*3600000);
    e.out=autoOut;e.autoClocked=true;e.activity=['Auto-clocked'];
    if(e.dbId){
      await sb.from('punches').update({
        clock_out:autoOut.toISOString(),
        activities:['Auto-clocked'],
        auto_clocked:true
      }).eq('id',e.dbId);
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

/* ─── Activity screen ─── */
function showActivityScreen(emp){
  document.getElementById('activity-emp-name').textContent=emp.name;
  selectedActs=new Set();
  document.getElementById('activity-error').textContent='';
  // Close dropdown if open
  document.getElementById('act-dropdown-list').style.display='none';
  document.getElementById('act-dropdown-arrow').textContent='▾';
  // Build dropdown list from active activities only
  renderActDropdown();
  renderActTags();
  showScreen('screen-activity');
}

function renderActDropdown(){
  const list=document.getElementById('act-dropdown-list');
  list.innerHTML=ACTIVITIES.map(a=>`
    <div class="act-dropdown-item${selectedActs.has(a.name)?' checked':''}" id="adrop_${a.id}" onclick="toggleDropAct('${a.name.replace(/'/g,"\'")}',${a.id})">
      <input type="checkbox" ${selectedActs.has(a.name)?'checked':''} onclick="event.stopPropagation()" onchange="toggleDropAct('${a.name.replace(/'/g,"\'")}',${a.id})" style="pointer-events:none;"/>
      <span>${a.name}</span>
    </div>`).join('');
  updateActDropdownLabel();
}

function renderActTags(){
  const tags=document.getElementById('act-tags');
  if(!selectedActs.size){tags.innerHTML='';return}
  tags.innerHTML=[...selectedActs].map(name=>`
    <span class="act-tag">${name}
      <button onclick="removeActTag('${name.replace(/'/g,"\'")}')">×</button>
    </span>`).join('');
}

function updateActDropdownLabel(){
  const lbl=document.getElementById('act-dropdown-label');
  const count=selectedActs.size;
  lbl.textContent=count===0?'Select activities…':`${count} activit${count===1?'y':'ies'} selected`;
  lbl.style.color=count>0?'var(--txt)':'var(--txt3)';
}

function toggleDropAct(name,id){
  if(selectedActs.has(name))selectedActs.delete(name);
  else selectedActs.add(name);
  document.getElementById('activity-error').textContent='';
  // Update just this item in place — avoids full re-render which collapses the dropdown
  const item=document.getElementById('adrop_'+id);
  if(item){
    const chk=item.querySelector('input[type=checkbox]');
    const checked=selectedActs.has(name);
    if(chk)chk.checked=checked;
    item.classList.toggle('checked',checked);
  }
  updateActDropdownLabel();
  renderActTags();
  // Ensure dropdown stays open
  const list=document.getElementById('act-dropdown-list');
  if(list)list.style.display='block';
  const arrow=document.getElementById('act-dropdown-arrow');
  if(arrow)arrow.textContent='▴';
}

function removeActTag(name){
  selectedActs.delete(name);
  renderActDropdown();
  renderActTags();
}

function toggleActDropdown(){
  const list=document.getElementById('act-dropdown-list');
  const arrow=document.getElementById('act-dropdown-arrow');
  const open=list.style.display==='none';
  list.style.display=open?'block':'none';
  arrow.textContent=open?'▴':'▾';
}

// Close dropdown when tapping outside
document.addEventListener('click',function(e){
  const wrap=document.querySelector('.act-dropdown-wrap');
  if(wrap&&!wrap.contains(e.target)){
    const list=document.getElementById('act-dropdown-list');
    const arrow=document.getElementById('act-dropdown-arrow');
    if(list)list.style.display='none';
    if(arrow)arrow.textContent='▾';
  }
},{passive:true});
async function confirmClockOut(){
  // Close dropdown if open
  document.getElementById('act-dropdown-list').style.display='none';
  if(selectedActs.size===0){document.getElementById('activity-error').textContent='Please select at least one activity.';return}
  const now=new Date();
  const entry=pendingClockOut.entry;
  const name=pendingClockOut.emp.name;
  entry.out=now;entry.activity=[...selectedActs];
  // Write to DB
  if(entry.dbId){
    const {error}=await sb.from('punches').update({
      clock_out:now.toISOString(),
      activities:[...selectedActs],
      auto_clocked:false
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
  const sel=document.getElementById('sup-login-name');
  sel.innerHTML='<option value="">— select your name —</option>'+supervisors.map(s=>`<option value="${s.id}">${s.name} (${(s.jobsites||[]).join(', ')||'No sites assigned'})</option>`).join('');
  document.getElementById('sup-login-pass').value='';document.getElementById('sup-login-err').textContent='';
  showScreen('screen-sup-login');
}
function masterLogin(){
  if(document.getElementById('master-pass-inp').value===MASTER_PASSWORD){
    stopSupTimeout();
    startMasterTimeout();
    sessionStorage.setItem('pt_session',JSON.stringify({type:'master',ts:Date.now()}));
  startMasterTimeout();
  showScreen('screen-master');switchMasterTab('overview');
  } else {document.getElementById('master-login-err').textContent='Incorrect master password.';}
}
function supLogin(){
  const id=parseInt(document.getElementById('sup-login-name').value);
  const pass=document.getElementById('sup-login-pass').value;
  const sup=supervisors.find(s=>s.id===id&&s.password===pass);
  if(!sup){document.getElementById('sup-login-err').textContent='Incorrect name or password.';return}
  activeSup={...sup, jobsites:sup.jobsites||[]};
  // activeSupSite = currently selected site for log/export (defaults to first)
  activeSup.activeSite = activeSup.jobsites[0]||null;
  document.getElementById('sup-dash-title').textContent=sup.name;
  const siteLabel=activeSup.jobsites.length>1
    ? activeSup.jobsites.join(' · ')
    : (activeSup.jobsites[0]||'No sites assigned');
  document.getElementById('sup-dash-site').textContent=`Supervising: ${siteLabel}`;
  stopMasterTimeout();startSupTimeout();
  sessionStorage.setItem('pt_session',JSON.stringify({type:'sup',supId:activeSup.id,ts:Date.now()}));
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
  if(tab==='log'){initLogDates();refreshSupLog();updateExportPreview();}
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
  // Query DB for auto-clocked count scoped to this supervisor's sites
  const {count:flagCount}=await sb.from('punches')
    .select('*',{count:'exact',head:true})
    .in('jobsite',sites)
    .eq('auto_clocked',true)
    .eq('edited_after_auto',false);
  document.getElementById('s-stat-punches').textContent=flagCount||0;
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
  // Always show export button — preliminary submissions allowed for in-progress periods
  exportBtn.style.display='block';
  if(exportable){
    exportNote.textContent='';
    exportBtn.textContent='Review & confirm submission →';
  } else {
    if(mode==='today'||mode==='yesterday'){
      exportNote.textContent='Note: This is a partial day view.';
      exportBtn.textContent='Export (partial) →';
    } else if(mode==='current'){
      exportNote.textContent='Period in progress — export now as a Preliminary report.';
      exportBtn.textContent='Submit preliminary report →';
    }
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
async function refreshSupLog(){
  await checkAutoServer();if(!activeSup)return;
  const fromV=document.getElementById('s-log-from').value;
  const toV=document.getElementById('s-log-to').value;
  let from=null,to=null;
  if(fromV){const[fy,fm,fd]=fromV.split('-').map(Number);from=new Date(fy,fm-1,fd,0,0,0,0);}
  if(toV){const[ty,tm,td]=toV.split('-').map(Number);to=new Date(ty,tm-1,td,23,59,59,999);}

  const sites=activeSup.jobsites||[];

  // Two-step query: find employees with any punch at supervisor's sites, then get ALL their punches
  let siteQuery=sb.from('punches').select('employee_id').in('jobsite',sites);
  if(from)siteQuery=siteQuery.gte('clock_in',from.toISOString());
  if(to)siteQuery=siteQuery.lte('clock_in',to.toISOString());
  const {data:siteData,error:siteErr}=await siteQuery;
  if(siteErr){showCustomAlert('Error','Could not load log: '+siteErr.message);return}

  const empIds=[...new Set((siteData||[]).map(r=>r.employee_id).filter(Boolean))];
  let logs=[];
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

  // Update export preview with same date range
  updateExportPreview();
  const container=document.getElementById('s-log-accordion');
  if(!logs.length){container.innerHTML='<p style="color:var(--txt2);text-align:center;padding:24px 0;font-size:13px;">No records for this period</p>';return}

  // Group by employee
  const empMap={};
  logs.forEach(l=>{
    if(!empMap[l.empId])empMap[l.empId]={name:l.name,dept:l.dept,records:[]};
    empMap[l.empId].records.push(l);
  });

  container.innerHTML=Object.entries(empMap).map(([empId,data])=>{
    const records=data.records;
    const totalHrs=records.reduce((s,l)=>s+(l.out?((l.out-l.in)/3600000):0),0);
    const flags=records.filter(l=>l.autoClocked).length;
    const still=records.filter(l=>!l.out).length;
    const summary=`${records.length} punch${records.length!==1?'es':''} · ${totalHrs.toFixed(1)}h${flags?` · <span style="color:#e07070;font-weight:600;">${flags} ⚠️ needs review</span>`:''}${still?` · <span style="color:var(--green);">${still} still in</span>`:''}`;
    const rows=records.map(l=>{
      const idx=timeLog.indexOf(l);
      const hrs=l.out?((l.out-l.in)/3600000).toFixed(2):'—';
      const outTxt=l.out?fmtDt(l.out):'<span style="color:var(--txt2)">Still in</span>';
      const actBadges=l.autoClocked?`<span class="badge b-auto">Auto-out ⚠️</span>`:(l.activity&&l.activity.length?l.activity.map(a=>`<span class="badge b-blue" style="margin-right:2px;">${a}</span>`).join(''):'—');
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
    return `<div class="emp-card">
      <div class="emp-card-header" onclick="toggleEmpCard('${cardId}')">
        <div>
          <p style="font-size:14px;font-weight:600;color:var(--txt);margin:0;">${data.name}</p>
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
}

function toggleEmpCard(id){
  const body=document.getElementById(id);
  const chev=document.getElementById(id+'-chevron');
  if(!body)return;
  const open=body.classList.toggle('open');
  if(chev)chev.textContent=open?'▾':'▸';
}

/* ─── Supervisor: Employees ─── */
function refreshSupEmps(){
  const tbody=document.getElementById('s-emp-table');
  tbody.innerHTML=employees.map(e=>`<tr>
    <td>${e.name}</td>
    <td><code style="font-size:12px;">${e.pin}</code></td>
    <td>${e.dept}</td>
    <td><span class="badge ${e.active?'b-in':'b-out'}">${e.active?'Active':'Inactive'}</span></td>
    <td style="white-space:nowrap;">
      <button class="btn-sm" onclick="openEmpModal(${e.id},'sup')" style="margin-right:4px;">Edit</button>
      <button class="btn-sm" onclick="openPinResetModal(${e.id})">Reset PIN</button>
    </td>
  </tr>`).join('');
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
function switchMasterTab(tab){
  ['overview','jobsites','employees','departments','activities','submissions','log'].forEach(t=>{
    document.getElementById('mpanel-'+t).style.display=t===tab?'block':'none';
    document.getElementById('mtab-'+t).classList.toggle('active',t===tab);
  });
  if(tab==='overview')refreshMasterOverview();
  if(tab==='jobsites'){refreshJobsitePanel();refreshNewJobsiteSupChecks();}
  if(tab==='employees')refreshMasterEmps();
  if(tab==='departments')refreshDepartmentsPanel();
  if(tab==='activities')refreshActivitiesPanel();
  if(tab==='submissions')refreshSubmissionsPanel();
  if(tab==='log'){populateMasterFilters();initMasterLogDates();refreshMasterLog();}
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
  const activeOnes=ALL_ACTIVITIES.filter(a=>a.active);
  list.innerHTML=ALL_ACTIVITIES.map((a,i)=>{
    const isActive=a.active;
    const activeIdx=activeOnes.indexOf(a);
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border:0.5px solid var(--bdr);border-radius:var(--radius);margin-bottom:7px;background:${isActive?'var(--bg2)':'var(--bg)'};opacity:${isActive?'1':'0.55'};">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="color:var(--txt3);font-size:12px;width:20px;text-align:right;">${isActive?activeIdx+1:'—'}</span>
        <div>
          <p style="font-size:13px;font-weight:500;color:${isActive?'var(--txt)':'var(--txt2)'};margin:0;">${a.name}</p>
          <p style="font-size:10px;color:var(--txt3);margin:0;">${a.code?'Code: '+a.code:'No code'}${isActive?'':' · Inactive'}</p>
        </div>
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;">
        <button class="btn-sm" onclick="openEditActivityModal(${a.id})">Edit</button>
        ${isActive?`
        <button class="btn-sm" onclick="moveActivity(${a.id},-1)" ${activeIdx===0?'disabled style="opacity:.3;"':''}>↑</button>
        <button class="btn-sm" onclick="moveActivity(${a.id},1)" ${activeIdx===activeOnes.length-1?'disabled style="opacity:.3;"':''}>↓</button>
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
async function refreshMasterOverview(){
  await checkAutoServer();
  const today=new Date();today.setHours(0,0,0,0);
  document.getElementById('m-stat-in').textContent=timeLog.filter(l=>!l.out).length;
  document.getElementById('m-stat-emps').textContent=employees.filter(e=>e.active).length;
  document.getElementById('m-stat-punches').textContent=timeLog.filter(l=>l.in>=today).length;
  // Query DB for auto-clocked count — memory only holds open punches so this must hit the DB
  const {count:flagCount}=await sb.from('punches')
    .select('*',{count:'exact',head:true})
    .eq('auto_clocked',true)
    .eq('edited_after_auto',false);
  document.getElementById('m-stat-flags').textContent=flagCount||0;
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
  document.getElementById('m-emp-table').innerHTML=employees.map(e=>{
    const isSup=e.dept==='Supervisor';
    const sites=(e.supervisorJobsites||[]).map(j=>`<span class="badge b-blue" style="font-size:10px;">${j}</span>`).join(' ');
    return `<tr>
      <td>${e.name}${isSup?'<span class="badge b-amber" style="font-size:10px;margin-left:4px;">SUP</span>':''}</td>
      <td><code style="font-size:12px;">${e.pin}</code></td>
      <td>${e.dept}</td>
      <td style="max-width:160px;">${isSup?(sites||'<span style="color:var(--txt3);font-size:11px;">None</span>'):'—'}</td>
      <td><span class="badge ${e.active?'b-in':'b-out'}">${e.active?'Active':'Inactive'}</span></td>
      <td style="white-space:nowrap;">
        <button class="btn-sm" onclick="openEmpModal(${e.id},'master')" style="margin-right:4px;">Edit</button>
        <button class="btn-sm danger" onclick="toggleEmpActive(${e.id})">${e.active?'Deactivate':'Activate'}</button>
      </td>
    </tr>`;
  }).join('');
}

/* ─── Master: Report ─── */
/* ─── Navigate from overview tiles to Report tab with pre-set filters ─── */
function goToReport({today=false, flags=false, site=''}={}){
  switchMasterTab('log');
  // Override filters after switchMasterTab's initMasterLogDates runs
  const now=new Date();
  const todayStr=toDateStr(now);
  if(flags){
    // Use current pay period date range
    const pp=getPeriodByOffset(0);
    document.getElementById('m-log-from').value=toDateStr(pp.start);
    document.getElementById('m-log-to').value=toDateStr(pp.end);
    document.getElementById('m-filter-flags').value='auto';
  } else if(today||site){
    document.getElementById('m-log-from').value=todayStr;
    document.getElementById('m-log-to').value=todayStr;
  }
  if(site)document.getElementById('m-filter-site').value=site;
  document.getElementById('m-filter-emp').value='';
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
  await checkAutoServer();
  const logs=await getMasterLogFiltered();
  _masterLogs=logs;
  // Update preview summary
  const prev=document.getElementById('m-report-preview');
  if(logs.length){
    const totalHrs=logs.reduce((s,l)=>s+(l.out?((l.out-l.in)/3600000):0),0);
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
    const hrs=l.out?((l.out-l.in)/3600000).toFixed(2):'—';
    const outTxt=l.out?fmtDt(l.out):'<span style="color:var(--txt2)">Still in</span>';
    const actBadges=l.autoClocked?`<span class="badge b-auto">Auto-out ⚠️</span>`:(l.activity&&l.activity.length?l.activity.map(a=>`<span class="badge b-blue" style="margin-right:2px;">${a}</span>`).join(''):'—');
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

/* ─── Master: Export confirm ─── */
let masterExportRange={from:null,to:null,siteF:'',empF:''};
function openMasterExportConfirm(){
  const logs=getMasterLogFiltered();
  if(!logs.length){showNotif('!','No records','Adjust filters to include at least one record','#EF9F27',2200);return}
  masterExportRange={logs};
  // Reuse the same confirmation modal — reset checkboxes
  ['chk1','chk2','chk3','chk4'].forEach(id=>{document.getElementById(id).checked=false});
  document.getElementById('confirm-err').textContent='';
  // Override the submit button to call doMasterExport
  document.getElementById('export-confirm-submit').onclick=doMasterExport;
  document.getElementById('export-confirm-modal').style.display='flex';
}
function doMasterExport(){
  const all=['chk1','chk2','chk3','chk4'].every(id=>document.getElementById(id).checked);
  if(!all){document.getElementById('confirm-err').textContent='Please confirm all items above before submitting.';return}
  const logs=_masterLogs||masterExportRange.logs||[];
  const header=['Employee','Department','Jobsite','Clock In','Clock Out','Hours','Activities','Auto-Clocked'];
  const rows=logs.map(l=>{
    const hrs=l.out?((l.out-l.in)/3600000).toFixed(2):'';
    return [l.name,l.dept,l.jobsite,fmtDt(l.in),l.out?fmtDt(l.out):'Still in',hrs,(l.activity||[]).join('; '),l.autoClocked?'YES':'NO'].map(v=>`"${v}"`).join(',');
  });
  const csv=[header.join(','),...rows].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  const now=new Date();
  a.href=url;a.download=`PanoramaTrack_MasterReport_${toDateStr(now)}.csv`;
  a.click();URL.revokeObjectURL(url);
  closeConfirmModal();
  showNotif('✓','Report exported',`${logs.length} records downloaded`,'#1D9E75',3000);
}

/* ─── Edit punch modal ─── */
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
  editActs=new Set(entry.activity||[]);
  document.getElementById('edit-emp-name').value=entry.name;
  document.getElementById('edit-in').value=toLocal(entry.in);
  document.getElementById('edit-out').value=entry.out?toLocal(entry.out):'';
  const jSel=document.getElementById('edit-jobsite');
  jSel.innerHTML=JOBSITES.map(j=>`<option${entry.jobsite===j?' selected':''}>${j}</option>`).join('');
  buildEditActGrid();
  document.getElementById('edit-err').textContent='';
  document.getElementById('edit-modal-bg').style.display='flex';
}
function buildEditActGrid(){
  document.getElementById('edit-act-grid').innerHTML=ACTIVITIES.map(a=>`<button class="act-btn${editActs.has(a.name)?' sel':''}" id="eact_${a.name.replace(/\s/g,'_')}" onclick="toggleEditAct('${a.name}')">${a.name}</button>`).join('');
}
function toggleEditAct(a){
  if(editActs.has(a))editActs.delete(a);else editActs.add(a);
  document.getElementById('eact_'+a.replace(/\s/g,'_')).classList.toggle('sel',editActs.has(a));
}
function closeEditModal(){
  document.getElementById('edit-modal-bg').style.display='none';
  editingIdx=null;_editEntry=null;
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
  closeEditModal();
  showNotif('✓','Punch deleted','Record permanently removed','#c47f17',2400);
  if(document.getElementById('spanel-log')?.style.display!=='none')refreshSupLog();
  if(document.getElementById('mpanel-log')?.style.display!=='none')refreshMasterLog();
}
async function saveEdit(){
  const err=document.getElementById('edit-err');
  const inV=document.getElementById('edit-in').value;const outV=document.getElementById('edit-out').value;
  if(!inV){err.textContent='Clock in time is required.';return}
  const newIn=new Date(inV);const newOut=outV?new Date(outV):null;
  if(newOut&&newOut<=newIn){err.textContent='Clock out must be after clock in.';return}
  const e=_editEntry||timeLog[editingIdx];
  const newJobsite=document.getElementById('edit-jobsite').value;
  const newActs=[...editActs];
  const wasAuto=e.autoClocked;
  const editedAfterAuto=wasAuto&&!!newOut;
  // Write to DB
  if(e.dbId){
    const upd={clock_in:newIn.toISOString(),jobsite:newJobsite,activities:newActs};
    if(newOut)upd.clock_out=newOut.toISOString();else upd.clock_out=null;
    if(editedAfterAuto){upd.auto_clocked=false;upd.edited_after_auto=true;}
    const {error}=await sb.from('punches').update(upd).eq('id',e.dbId);
    if(error){err.textContent='DB error: '+error.message;return}
  }
  // Update memory
  e.in=newIn;e.out=newOut;e.jobsite=newJobsite;e.activity=newActs;
  if(editedAfterAuto){e.autoClocked=false;e.editedAfterAuto=true;}
  closeEditModal();
  if(document.getElementById('spanel-log')?.style.display!=='none')refreshSupLog();
  if(document.getElementById('mpanel-log')?.style.display!=='none')refreshMasterLog();
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
  const pin=document.getElementById('emp-pin-inp').value.trim();
  const dept=document.getElementById('emp-dept-inp').value;
  const err=document.getElementById('emp-err');
  if(!name||!pin||!dept){err.textContent='All fields are required.';return}
  if(!/^\d{4,6}$/.test(pin)){err.textContent='PIN must be 4–6 digits.';return}
  const dup=employees.find(e=>e.pin===pin&&e.id!==editingEmpId);
  if(dup){err.textContent='PIN already in use by '+dup.name+'.';return}

  // Supervisor-specific fields
  let supPass=null, supJobsites=[];
  if(dept==='Supervisor'){
    supPass=document.getElementById('emp-sup-pass').value.trim();
    if(!supPass){err.textContent='Supervisor password is required.';return}
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
  const total=logs.reduce((s,l)=>s+(l.out?((l.out-l.in)/3600000):0),0);
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
    if(modalTitle)modalTitle.textContent='Preliminary submission confirmation';
    if(submitBtn)submitBtn.textContent='Submit preliminary report →';
    submitBtn.style.background='var(--amber)';
  } else {
    if(prelimSection)prelimSection.style.display='none';
    if(modalTitle)modalTitle.textContent='Supervisor confirmation required';
    if(submitBtn)submitBtn.textContent='Submit & export PDF';
    submitBtn.style.background='var(--green)';
  }
  document.getElementById('export-confirm-modal').style.display='flex';
}
function closeConfirmModal(){document.getElementById('export-confirm-modal').style.display='none'}
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
      // Key by date + jobsite so different sites on same day stay separate rows
      const dayKey=p.in.toDateString()+'|'+(p.jobsite||'');
      if(!dayMap[dayKey])dayMap[dayKey]={
        date:p.in,clockIn:p.in,clockOut:p.out,
        hrs:0,acts:new Set(),jobsite:p.jobsite||'—',
        hasAuto:false,hasEstimated:false
      };
      const d=dayMap[dayKey];
      if(p.in<d.clockIn)d.clockIn=p.in;
      if(p.out&&(!d.clockOut||p.out>d.clockOut))d.clockOut=p.out;
      if(p.out)d.hrs+=((p.out-p.in)/3600000);
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
async function refreshSubmissionsPanel(){
  const list=document.getElementById('submissions-list');
  list.innerHTML='<p style="color:var(--txt2);font-size:13px;padding:12px 0;">Loading…</p>';
  const {data,error}=await sb.from('submissions').select('*').order('submitted_at',{ascending:false});
  if(error){list.innerHTML='<p style="color:var(--red);">Error loading submissions.</p>';return}
  const subs=data||[];
  // Populate period filter
  const periods=[...new Set(subs.map(s=>s.period_start))].sort().reverse();
  const supNames=[...new Set(subs.map(s=>s.submitted_by))].sort();
  const pSel=document.getElementById('sub-filter-period');
  const sSel=document.getElementById('sub-filter-sup');
  const curP=pSel.value,curS=sSel.value;
  pSel.innerHTML='<option value="">All periods</option>'+periods.map(p=>{
    const ps=new Date(p+'T00:00:00');
    const label=ps.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'});
    return `<option value="${p}"${p===curP?' selected':''}>${label}</option>`;
  }).join('');
  sSel.innerHTML='<option value="">All supervisors</option>'+supNames.map(s=>`<option${s===curS?' selected':''}>${s}</option>`).join('');
  // Filter
  let filtered=subs;
  if(curP)filtered=filtered.filter(s=>s.period_start===curP);
  if(curS)filtered=filtered.filter(s=>s.submitted_by===curS);
  if(!filtered.length){list.innerHTML='<p style="color:var(--txt2);text-align:center;padding:20px;font-size:13px;">No submissions match.</p>';return}
  // Group by period
  const byPeriod={};
  filtered.forEach(s=>{
    if(!byPeriod[s.period_start])byPeriod[s.period_start]=[];
    byPeriod[s.period_start].push(s);
  });
  list.innerHTML=Object.entries(byPeriod).sort((a,b)=>b[0].localeCompare(a[0])).map(([ps,records])=>{
    const pStart=new Date(ps+'T00:00:00');
    const pEnd=new Date(records[0].period_end+'T00:00:00');
    const periodLabel=`${pStart.toLocaleDateString([],{month:'short',day:'numeric'})} – ${pEnd.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}`;
    const rows=records.map(s=>{
      const dt=new Date(s.submitted_at);
      const dtStr=dt.toLocaleDateString([],{month:'short',day:'numeric'})+' '+dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      const badge=s.status==='preliminary'?'<span class="badge b-amber" style="font-size:10px;">Preliminary</span>':'<span class="badge b-in" style="font-size:10px;">Final</span>';
      return `<tr>
        <td>${s.employee_name} ${badge}</td>
        <td style="font-size:11px;color:var(--txt2);">${s.submitted_by}</td>
        <td style="font-size:11px;color:var(--txt2);">${dtStr}</td>
        <td><button class="btn-sm danger" onclick="deleteSubmission(${s.id},'${s.employee_name.replace(/'/g,"\'")}')">Clear</button></td>
      </tr>`;
    }).join('');
    return `<div style="margin-bottom:14px;">
      <p style="font-size:11px;font-weight:600;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Period: ${periodLabel}</p>
      <div style="border:0.5px solid var(--bdr);border-radius:var(--radius);overflow:hidden;">
        <table><thead><tr><th>Employee</th><th>Submitted by</th><th>Date &amp; time</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>
    </div>`;
  }).join('');
}

function deleteSubmission(id,empName){
  showCustomConfirm(
    `Clear submission for ${empName}?`,
    'This will allow this employee to be submitted again for the same pay period.',
    'The supervisor will no longer see a duplicate warning for this employee.',
    'Clear record',
    'var(--amber)',
    async()=>{
      const {error}=await sb.from('submissions').delete().eq('id',id);
      if(error){showCustomAlert('Error','Could not delete: '+error.message);return}
      refreshSubmissionsPanel();
      showNotif('✓','Submission cleared',empName+' can be resubmitted','#c47f17',2400);
    }
  );
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
    const payload={backed_up_at:new Date().toISOString(),app_version:'v35.2',tables};
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

/* ─── Session persistence across refresh (10 min window) ─── */
const SESSION_PERSIST_MS = 10 * 60 * 1000;
function tryRestoreSession(){
  try{
    const raw=sessionStorage.getItem('pt_session');
    if(!raw)return;
    const s=JSON.parse(raw);
    if(!s||!s.ts)return;
    if(Date.now()-s.ts>SESSION_PERSIST_MS){sessionStorage.removeItem('pt_session');return;}
    if(s.type==='master'){
      startMasterTimeout();
      showScreen('screen-master');switchMasterTab('overview');
    } else if(s.type==='sup'&&s.supId){
      const sup=supervisors.find(sv=>sv.id===s.supId);
      if(!sup){sessionStorage.removeItem('pt_session');return;}
      activeSup={...sup,jobsites:sup.jobsites||[]};
      activeSup.activeSite=activeSup.jobsites[0]||null;
      document.getElementById('sup-dash-title').textContent=sup.name;
      const siteLabel=activeSup.jobsites.length>1?activeSup.jobsites.join(' · '):(activeSup.jobsites[0]||'No sites assigned');
      document.getElementById('sup-dash-site').textContent='Supervising: '+siteLabel;
      startSupTimeout();
      showScreen('screen-sup');switchSupTab('live');
    }
  }catch(e){sessionStorage.removeItem('pt_session');}
}


/* ─── Supervisor inactivity timeout (15 min) ─── */
const SUP_TIMEOUT_MS = 15 * 60 * 1000;
const SUP_WARN_MS    = 14 * 60 * 1000;
let supTimeoutTimer=null;
let supWarnTimer=null;

function resetSupTimer(){
  clearTimeout(supTimeoutTimer);clearTimeout(supWarnTimer);
  document.getElementById('timeout-bar').style.display='none';
  supWarnTimer=setTimeout(()=>{
    document.getElementById('timeout-bar').style.display='block';
  },SUP_WARN_MS);
  supTimeoutTimer=setTimeout(()=>{
    document.getElementById('timeout-bar').style.display='none';
    activeSup=null;
    sessionStorage.removeItem('pt_session');
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
  masterWarnTimer=setTimeout(()=>{
    document.getElementById('timeout-bar').style.display='block';
  },MASTER_WARN_MS);
  masterTimeoutTimer=setTimeout(()=>{
    document.getElementById('timeout-bar').style.display='none';
    sessionStorage.removeItem('pt_session');
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

