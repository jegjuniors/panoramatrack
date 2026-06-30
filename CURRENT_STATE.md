# PanoramaTrack — Current State

**Current Version:** v42.2
**Last Updated:** June 30, 2026

---

## 🗂 File Structure

| File | Purpose |
|---|---|
| `index.html` | All UI markup, modals, screens |
| `app.js` | All logic, Supabase calls, state |
| `styles.css` | All styling |
| `payroll-template.js` | **(v40.0)** Embedded base64 blank payroll Excel template, loaded by the Excel-pack export. Auto-generated — do not hand-edit. |
| `CURRENT_STATE.md` | This file — project state tracker |
| `PanoramaTrack_Future_Features.md` | Roadmap / future ideas |

---

## 🗄 Database (Supabase)

**Tables:** `employees`, `jobsites`, `departments`, `activities`, `punches`, `submissions`, `pt_settings`

`pt_settings` (added v36.1, extended v36.2) is a single config row (`id = 1`) holding app-wide pay rules: `rounding_enabled`, `rounding_minutes`, `sched_end_enabled`, `sched_end_time`, `sched_end_window`, `lunch_enabled`, `lunch_minutes`, `lunch_threshold_hours`. Loaded on boot into `APP_SETTINGS`; edited in the master admin Settings tab. Rules are display/export-only — punch rows are never modified.

`punches` columns of note: `employee_id`, `employee_name`, `department`, `jobsite`, `clock_in`, `clock_out`, `activities` (array), `auto_clocked`, `edited_after_auto`, `manual_entry` (bool, added v37.0 — true for punches created/edited via the supervisor/master manual Add-punch flow OR (v41.0) via employee self-edit in My Timecard; surfaces an amber "✎ Manual" badge in the logs either way — no separate flag distinguishes who made the edit), `lunch_waive_requested` + `lunch_waived` (v42.0 — per-shift lunch waive, see below).

**Lunch waive columns (v42.0, SQL run by Julio):**
- `lunch_waive_requested` (bool, `NOT NULL DEFAULT false`) — the employee's "I worked through lunch" tick at clock-out. Always true/false.
- `lunch_waived` (bool, **nullable, no default**) — the supervisor's decision. Three states by design: `NULL` = pending (no decision yet), `true` = approved (skip the lunch deduction for this punch), `false` = denied (keep the deduction). Code must check `=== true` / `IS NULL` explicitly, never truthiness (null and false are both falsy in JS).
- A punch is a **pending waive** when `lunch_waive_requested = true AND lunch_waived IS NULL` — that's the condition surfaced by the needs-review filter, the Needs Review tile, and the supervisor export gate. Helper: `isPendingWaive(entry)` in app.js.

Supervisors are employees with `dept = 'Supervisor'`. Supervisor password stored in `supervisor_password` column. Supervisor jobsite assignments stored in `supervisor_jobsites` (text array).
No separate supervisors table.

---

## ⚠️ Standing Build Rules / Gotchas (read before every build)

- **Dark-mode text color — NEVER rely on the browser default.** The app defaults to dark mode (`body` background is near-black `#000`), but no global rule colors bare text/headings. Any element whose color isn't set by a class or inline style falls back to browser-default **black → invisible in dark mode.** This has bitten us twice now (v40.1 review-gate names, v41.0 My Timecard heading). **Rule going forward: every new text element — headings, `<strong>`, custom spans, dynamically-injected HTML — must get an explicit theme-aware color (`color:var(--txt)` / `--txt2` / `--txt3`), never a hard-coded hex and never nothing.** A global `h1,h2,h3,h4{color:var(--txt)}` fallback was added in v41.0 to catch bare headings, but injected markup and non-heading elements still need explicit colors. Use the `--txt*` vars (they flip per theme automatically); avoid literal `#000`/`#111`/`black`.
- **`position:fixed` bars** rely on `#app` having no `transform`/`filter`/`contain` (which would trap fixed descendants) — keep it that way.
- **Native scrollbars are invisible on mobile/PWA** — use the custom JS scroll-rail pattern (see v39.1), not CSS scrollbar styling.
- **Stale-render races** in async refreshers — guard with a sequence number (e.g. `_supLogSeq`, `_masterLogSeq`).
- **Row-template variables must survive edits.** The log row builders (`refreshMasterLog`/`refreshSupLog`) declare locals (`color`, `si`, `idx`, `hrs`…) just above the `return` template literal. When inserting badges or columns near there, don't delete those `const` lines — a missing one throws `ReferenceError` *inside* the `.map()` and silently blanks the whole table (bit us in v42.0 → fixed v42.2). After editing a row builder, smoke-test that the log still renders rows.

---

## ✅ Features Currently Working

- Employee PIN clock-in / clock-out with jobsite + activity selection
- Auto-clock out at 12 hours (flagged with orange border in logs)
- Supervisor panel: view/edit punches, preliminary & final PDF export
- Master admin panel: manage employees, jobsites, activities, departments
- Pay period logic: bi-weekly, anchored date, with offset support
- Duplicate submission detection (blocks re-submitting a final)
- Archived jobsites panel
- Submissions tracking panel (master admin)
- Dark/light/auto theme toggle (kiosk + persists app-wide)
- PWA manifest + installable on iOS/Android
- PDF export with activity codes (e.g. `41-001 (Interior Steel)`)
- Preliminary export allowed for in-progress periods
- Multi-period view in supervisor log (Today / Yesterday / Current / Last / 2 periods ago)
- Master admin Report tab: same period buttons as supervisor (Today / Yesterday / Current / Last / 2 periods ago), defaults to current pay period on open
- In-app "Backup Now" button (master admin) — downloads JSON of all tables
- Corfix safety reminder — pops up at clock-in if jobsite has a Corfix URL configured
- Jobsite extra fields — address, GC, job number, Corfix URL (editable in master admin)
- **Session persistence across app close/reopen** — supervisors and master admin stay logged in for up to 8 hours (refreshes on activity); stored in `localStorage` so it survives tab close and returning to the app
- **Supervisor permission gating** — a supervisor cannot change another supervisor's kiosk PIN or login password (admin only); they can still change their own and manage regular employees' PINs. UI-level guard (Reset PIN button hidden + PIN field locked + password field hidden when editing another supervisor), with a matching guard in `saveEmployee` against DOM tampering
- **Clickable Live tiles (supervisor panel)** — the three Live stat tiles now jump to the Time log with the right view: Head Count → Today + "still clocked in only"; Yesterday's Head Count → Yesterday; Needs Review → "needs review only" showing ALL outstanding flagged records (period-independent, matches the tile count). Backed by a new filter dropdown on the supervisor Time log (`s-filter-flags`: All records / Still clocked in only / Needs review only)
- **Review gate on supervisor submit** — a supervisor cannot submit a report (preliminary OR final) while any punch in the selected range is still auto-clocked. A blocking modal lists the affected employees + clock-in times; "Review these now" jumps the Time log into the needs-review filter to fix them. The gate clears automatically as each auto-clock is edited to a real clock-out. Master admin export is intentionally NOT gated (admin override) — instead it gets a non-blocking warning (see v40.1 below).
- **Configurable pay rules (master admin Settings tab, v36.1 + v36.2)** — three admin-toggleable rules, all Supabase-backed (shared across devices) and display/export-only (raw punches untouched):
  - **Punch-time rounding** — rounds each clock-in/out to nearest 15 / 6 / 5 min (neutral nearest-mark / 7-8 rule). Default 15 min, off by default.
  - **Paid break-in-lieu credit** — clock-outs within a window (default 15 min) before a scheduled end (default 3:30 PM) are paid to the scheduled end; later punch-outs are never clipped. Off by default.
  - **Unpaid lunch deduction (v36.2)** — subtracts an unpaid lunch (default 30 min) from any shift longer than a threshold (default 5h, deduction applies to shifts *over* the threshold). Off by default. Applied as the final step after credit-then-round. With it enabled, a 7:00–3:30 day now reads **8.0h** (8.5h elapsed − 0.5h lunch). Auto-clocked and estimated punches are left exact, same as the other two rules.
  - Order: credit → round → lunch. Auto-clocked and estimated punches are always left exact. On-screen review tables show RAW times with PAID hours; PDF/CSV exports show ADJUSTED times + paid hours.
- **Manual punch entry (v37.0)** — "+ Add punch" button in both the supervisor and master logs, for an employee who forgot to clock in/out entirely. Reuses the edit modal in an add mode (`openAddPunchModal(ctx)`): employee dropdown (full active roster, alphabetical), clock-in (required), clock-out (optional — covers in-only cases), jobsite, activities. Inserts a new `punches` row with `manual_entry = true`, shown with an amber "✎ Manual" badge in both logs. Both supervisors and master can use it; supervisor scope is the full roster (per Julio's call). NOT included this version (noted for future): overlap guard against double-booking an employee, and a manual marker in CSV/PDF exports.
- **Master admin export — review warning instead of checklist (v40.1)** — the old shared 4-checkbox checklist is gone from the admin export path. `openMasterExportConfirm()` now checks the current filtered log for auto-clocked/unreviewed punches: none found → straight to the PDF/Excel Pack format picker (`#master-format-modal`); some found → a non-blocking warning modal (`#master-review-modal`) showing a count (expandable to the full name + clock-in list), with "Review now" (jumps to the master log's needs-review filter via the existing `goToReport({flags:true})`) or "Export anyway" (secondary/outline-styled override button → proceeds to the format picker). Admin export remains intentionally ungated — this is a heads-up, not a block. Supervisor's checklist/review-gate modal is untouched.
- **Quick-set time buttons on Edit/Add Punch modals (v40.1)** — saves having to pick a date/time for the common case of fixing an auto-clock-out or backfilling a forgotten punch. Edit Punch modal: Clock-out gets two buttons, **3:15 PM** / **3:30 PM**, which stamp that time onto the *same date as the punch's existing clock-in* (correct for fixing an auto-clock from any day, not just today). Add Manual Punch modal: Clock-in gets **Today 7:00 AM** / **Yesterday 7:00 AM**; Clock-out gets **Today 3:15/3:30 PM** / **Yesterday 3:15/3:30 PM** (4 buttons). Implemented as `quickSetEditOut(hh,mm)` and `quickSetAddTime(fieldId,'today'|'yesterday',hh,mm)`; the three button rows (`#out-quickset-edit`, `#in-quickset-add`, `#out-quickset-add`) are toggled by `openEditModal()` / `openAddPunchModal()` since the modal is shared between both flows.
- **My Timecard — employee self-edit (v41.0)** — a new "My Timecard" option on the kiosk screen, beside Clock In / Out, so employees can fix their own forgotten/incorrect punches without going through the supervisor. Employee enters their PIN (same as clock-in) to open `submitTimecardPin()` → `openMyTimecard(emp)`, which lists their punches for the **current pay period only** (`getPeriodByOffset(0)`), pulled fresh from Supabase. They can edit any of the four fields on an existing punch (clock-in, clock-out, jobsite, activities) via `openMyTcEdit(dbId)`, or add a punch they forgot entirely (missing clock-in or clock-out) via `openMyTcAdd()` — a simplified single modal shared between both flows (`#mytc-edit-modal-bg`), not the full supervisor Add-Punch modal. Every self-edit applies **immediately** (no approval queue — the agreed "flagged-but-live" model) and is written with `manual_entry = true`, the same flag supervisors already use, so it surfaces with the existing amber "✎ Manual" badge in the supervisor/master logs — no new flag, no separate before/after audit trail; supervisors follow up with the employee directly if a flagged edit looks off. **Locked once submitted:** if the current period already has a `final` row in `submissions` for that employee, the screen goes view-only (`mytc-locked-note` shown, Add/Edit buttons hidden) — only a supervisor or master admin can touch it from that point. No min/max time-shift guardrail (per Julio's call) beyond staying inside the current period's date range.

---

## 🚧 What Was Last Being Worked On

**Last session date:** June 30, 2026
**Tasks completed this session:**
- **v42.2 — Bugfix: admin reporting log rendered nothing (regression from v42.0):** The master reporting log showed no rows for any filter/date range. Cause: the v42.0 edit that added the 🍴 lunch-waive badges to `refreshMasterLog()` accidentally deleted the adjacent line `const si=JOBSITES.indexOf(l.jobsite);const color=si>=0?getSiteColor(si):'#555';`. The row template still referenced `${color}` for the jobsite stripe, so each row threw `ReferenceError: color is not defined` *inside* the `.map()` callback, which aborted the whole `tbody.innerHTML` assignment → empty table. Filters/dropdowns/date logic were never affected; only row rendering. Fix: restored the one deleted line right before the row `return`. `app.js` only.

**Last session date:** June 30, 2026
**Tasks completed this session:**
- **v42.1 — Lunch waive toggle moved to top of activities list:** Contained UI tweak. The "I worked through lunch" toggle card (`#lunch-waive-row`) now sits *above* `#act-list` instead of below it, so it's the first thing seen on the clock-out screen. `margin-top:14px` → `margin-bottom:14px` for correct spacing above the list. No JS change — the custom scroll-rail math (`updateActScroll`) reads total page scroll height regardless of element order, so it's unaffected. `index.html` only (+ this doc).

**Last session date:** June 30, 2026
**Tasks completed this session:**
- **v42.0 — Per-shift lunch waive (worked-through-lunch request + supervisor approval):** Closes the last piece of the lunch arc. Automatic lunch deduction (v36.2) docks 30 min from any shift over 5h; this lets an employee who genuinely skipped lunch and left early request that the deduction be waived — but as a *request the supervisor approves*, never an auto-apply, so there's no standing daily incentive for 50–100 people to claim free time.
  - **Design (all confirmed with Julio before build, one question at a time):**
    1. **Two flags, not one.** `lunch_waive_requested` = the employee's ask; `lunch_waived` = the supervisor's decision. Request ≠ approval.
    2. **`lunch_waived` is a nullable boolean** (null/true/false = pending/approved/denied) rather than a separate status column — same three states, one column, `paidHours` still checks a plain boolean. Chosen over an enum because the states won't multiply.
    3. **Capture = always-visible toggle on the clock-out (activity) screen**, no popup, no threshold gating the prompt. Employee ticks "I worked through lunch (no break taken)" → sets `lunch_waive_requested=true`. Threshold is handled downstream: an approved waive on a short shift simply has nothing to subtract.
    4. **Approval = per-punch approve/deny in the edit modal**, surfaced via the **export gate** (not a standalone review screen). The gate — previously triggered only by unresolved auto-clocks — now also blocks on pending waives, listing both kinds.
    5. **Bulk "Approve all for [Name]"** inline in the export-gate modal (common case: someone worked through lunch all period). **Denial stays individual** (more scrutiny) — done one-at-a-time via "Review these now" → edit modal.
    6. **Needs-review filter + Needs Review tile** now catch pending waives in addition to auto-clocks, so "Review these now" lands on a combined list and the tile count matches.
  - **DB migration (Julio ran before build):** `ALTER TABLE punches ADD COLUMN lunch_waive_requested boolean NOT NULL DEFAULT false;` and `ADD COLUMN lunch_waived boolean;` (nullable, no default). Existing rows: requested=false, waived=null — so none are caught by the gate. No backfill.
  - **Engine:** `paidHours()` skips the lunch deduction only when `entry.lunchWaived===true` (explicit `===`, not truthiness — null/false both keep the deduction). New `isPendingWaive(entry)` helper (`requested===true && waived==null`) is the single source of truth for the gate, filter, and tile. `dbRowToEntry()` maps both columns (`lunchWaiveRequested`, `lunchWaived`).
  - **Capture:** new `#lunch-waive-row` toggle card on `#screen-activity` (at the top of the activities list, above `#act-list`, visually set apart); `lunchWaiveRequested` global + `toggleLunchWaive()`; reset in `showActivityScreen()`; written in `confirmClockOut()` alongside the activities/clock-out update.
  - **Approval UI:** `#edit-waive-wrap` block in the shared edit modal, shown only when the punch carries a request (`setupEditWaive(entry)`); Approve/Deny buttons (`setEditWaive(bool)` → `_editWaiveDecision`, rendered by `_renderEditWaive()`); persisted in `saveEdit()` only when a decision was made this session (`_editWaiveDecision!==null`). Hidden in Add-Punch mode.
  - **Surfacing:** status chips (🍴 Waive pending / Waived / Waive denied) added to both supervisor and master log rows; supervisor per-employee summary gained a pending-waive count; supervisor needs-review query (`refreshSupLog` `review` branch) and Needs Review tile (`refreshSupLive`) extended with an `.or(...)` / second count for pending waives.
  - **Export gate:** `openExportConfirm()` now collects `pendingWaives` alongside `needsReview` and blocks if either is non-empty. `showReviewGate(autoList, waiveList)` rewritten with two labeled sections; waives grouped by employee with an "Approve all" button → `approveAllWaivesFor(empId)` (bulk `lunch_waived=true`, heals memory, then re-runs `openExportConfirm()` so the gate clears or advances). Master export path remains intentionally ungated (badges only).
  - **Files changed:** `index.html` (lunch-waive toggle on `#screen-activity`; `#edit-waive-wrap` approve/deny block in edit modal; restructured `#review-gate-bg` into auto + waive sections; version badge → v42.0). `app.js` (`dbRowToEntry`, `paidHours`, new `isPendingWaive`/`toggleLunchWaive`/`setupEditWaive`/`_renderEditWaive`/`setEditWaive`/`approveAllWaivesFor`; `showActivityScreen`, `confirmClockOut`, `openEditModal`, `openAddPunchModal`, `saveEdit`, `refreshSupLog`, `refreshSupLive`, `refreshMasterLog`, `openExportConfirm`, `showReviewGate`; `lunchWaiveRequested`/`_editWaiveDecision`/`_reviewGateWaives` state; backup payload → v42.0).
  - **Note / to verify in testing:** `approveAllWaivesFor()` re-runs `openExportConfirm()` after writing, which re-fetches fresh logs so the gate either clears or advances to the next step. Confirm that flow feels right in practice.
  - **Scope deliberately left out:** the lunch-waive toggle is on the main clock-out screen only — it is NOT surfaced in the v41.0 "My Timecard" employee self-edit path (would be scope creep; not discussed). If an employee edits a punch in My Timecard, the waive flags are left as they were.

**Last session date:** June 30, 2026
**Tasks completed this session:**
- **v41.0 — My Timecard: employee self-edit of their own punches:** Too many employees were forgetting to clock in or out entirely, and chasing every one down was overloading the supervisor. This adds a new self-service path so employees can correct their own punches directly, scoped tightly enough to keep the existing supervisor-policing model intact.
  - **Design (confirmed with Julio before build):** employees can edit only their own punches, and only within the **current pay period** — once that period has a final submission on record, only a supervisor/master admin can touch it from then on. Edits **apply immediately** (flagged-but-live, not a request/approval queue, matching Julio's call). All four punch fields are editable (clock-in, clock-out, jobsite, activities), including adding a punch the employee forgot entirely. No before/after value is retained — the supervisor follows up directly with the employee if a flagged edit looks off. No min/max time-shift guardrail beyond staying inside the current period.
  - **Access:** a new **"My Timecard"** button sits beside the existing "Clock In / Out" button on the kiosk screen. Employee enters their PIN (same PIN pad, same lookup as clock-in) → `submitTimecardPin()` → `openMyTimecard(emp)`.
  - **Screen (`#screen-mytc`):** lists the employee's own punches for the current pay period only, queried fresh from Supabase each time (not from the in-memory `timeLog`, which only caches open punches). Each punch shows date, jobsite, in/out times, activities, and the existing "In" / "✎ Manual" / "Auto-clocked" badges. A "+ Add a missed punch" button sits above the list.
  - **Editing:** reuses a dedicated, simplified modal (`#mytc-edit-modal-bg` — separate from the supervisor/master `#edit-modal-bg` to avoid entangling employee-permission logic with that modal's existing add/edit/admin branches) for both "edit an existing punch" (`openMyTcEdit(dbId)`) and "add a missed punch" (`openMyTcAdd()`). Saving validates clock-out > clock-in and that both timestamps fall inside the current pay period, then writes with **`manual_entry = true`** — intentionally reusing the existing flag rather than adding a new one, so self-edits surface with the same amber "✎ Manual" badge supervisors already watch for in the supervisor/master logs (per Julio's call — no separate audit flag).
  - **Submission lock:** on opening "My Timecard", queries `submissions` for a `status = 'final'` row for that employee overlapping the current period (same overlap check the export duplicate-detection already uses). If found, the screen goes view-only — `#mytc-locked-note` is shown and the Add/Edit buttons are hidden.
  - **Open-punch consistency:** if an employee uses this to add their own missing clock-out, the in-memory `timeLog` cache on that device is updated/closed too, consistent with how the existing supervisor `saveEdit()` keeps memory and DB in sync.
  - **Roadmap impact:** this took the v41.0 slot that had been earmarked for the per-shift lunch-waive feature — that feature is now pushed to **v42.0** (see updated roadmap section below).
  - **Files changed:** `index.html` ("My Timecard" button + `#screen-mytc` + `#mytc-edit-modal-bg` markup; version badge). `app.js` (new `submitTimecardPin()`, `openMyTimecard()`, `closeMyTimecard()`, `renderMyTcList()`, `openMyTcAdd()`, `openMyTcEdit()`, `buildMyTcActGrid()`, `toggleMyTcAct()`, `closeMyTcEditModal()`, `saveMyTcEdit()`; new state vars `myTcEmp`/`myTcPeriod`/`myTcPunches`/`myTcLocked`/`myTcEditingDbId`/`myTcAdding`/`myTcEditActs`; backup payload version). No DB migration needed — reuses the existing `manual_entry` column.
  - **Post-build fix 1 — blank screen on load:** the new `#mytc-edit-modal-bg` modal was accidentally nested *inside* the still-open existing `#edit-modal-bg` modal, leaving two `<div>`s unclosed and breaking the whole DOM render. Fixed by closing the Edit Punch modal before opening the My Timecard modal (siblings, not nested). `index.html` only.
  - **Post-build fix 2 — black/unreadable heading in dark mode:** the My Timecard screen `<h2>` (`#mytc-name`) had no color rule and fell back to browser-default black, invisible on the dark background (same class of bug as the v40.1 review-gate names). Fixed by (a) adding a global `h1,h2,h3,h4{color:var(--txt)}` fallback in `styles.css` so no bare heading can hit this again, and (b) setting `color:var(--txt)` inline on `#mytc-name`. Also logged as a **standing build rule** in the new "Standing Build Rules / Gotchas" section near the top of this doc — all future text elements must get an explicit theme-aware color, never browser default. `styles.css` + `index.html`.


**Last session date:** June 25, 2026
**Tasks completed this session:**
- **v40.1 — Admin export checklist removed + review warning, dark-mode fix, needs-review race fix, quick-set time buttons:** A bundle of contained UI/bugfix tweaks, no structural changes.
  - **Master admin export — checklist replaced with a conditional warning.** The shared 4-checkbox checklist (`chk1`–`chk4`) that the master export path borrowed from the supervisor submit flow is gone. `openMasterExportConfirm()` now checks `_masterLogs` for any `autoClocked` records: if none, it jumps straight to the format picker (no extra modal at all — fewer clicks than before); if some exist, a new dedicated warning modal (`#master-review-modal`) shows a count (expandable via "Show details" to the full name + clock-in list, same data shape as the supervisor review-gate), with **Review now** (`masterReviewGoNow()` → reuses the existing `goToReport({flags:true})` to jump the master log into the needs-review filter) and **Export anyway** (styled as a secondary/outline button — a deliberate override, not the default next-step) → proceeds to a new dedicated format-picker modal (`#master-format-modal`, just the PDF/Excel Pack buttons, no checkboxes). Admin export stays intentionally ungated per existing design — this is a heads-up, not a block. Built as fully separate modals/functions from the supervisor's `#export-confirm-modal` so the supervisor checklist + blocking review-gate are completely untouched.
  - **Dark mode fix — review-gate employee names were invisible.** In `showReviewGate()`, the employee `<strong>` name had no explicit text color; nothing further up the DOM chain sets `color` either (`body{}` only sets background), so it fell back to the browser default (black) — invisible against the dark theme's near-black background. Fixed by adding `color:var(--txt)` directly on the `<strong>`. Same pattern was used for the new master review-warning list to avoid the same bug there.
  - **"Review these now" — fixed a stale-render race.** `goToSupReport('review')` calls `switchSupTab('log')`, which (via `initLogDates()`) resets the filter dropdown to default and kicks off its own `refreshSupLog()` call *before* the caller sets the filter to `'review'` and fires a second one — two competing async calls updating the same DOM, whichever resolves last wins. Fixed with a sequence-number guard (`_supLogSeq`): each call captures its own sequence number and only renders if it's still the latest one when its data arrives; any older, now-superseded call's results are silently dropped instead of overwriting the correct list. Also removed a redundant duplicate `refreshSupLog()`/`updateExportPreview()` call that `switchSupTab('log')` was firing on top of the one already triggered inside `initLogDates()` — that redundancy existed on every normal "Log" tab click too, not just this path. Applied the same `_masterLogSeq` guard to `refreshMasterLog()` for consistency, since the new "Review now" button on the master side reuses the identical `switchMasterTab('log')` → override filter → refresh pattern.
  - **Quick-set time buttons — Edit Punch & Add Manual Punch modals.** Saves picking a date/time by hand for the common case of fixing an auto-clock-out or backfilling a forgotten punch (these two modals share the same `#edit-in`/`#edit-out` fields). Edit Punch: Clock-out gets **3:15 PM** / **3:30 PM** buttons (`quickSetEditOut(hh,mm)`), which stamp that time onto the *same date as the punch's current clock-in value* — correct for fixing an auto-clock from any day, not just today. Add Manual Punch: Clock-in gets **Today 7:00 AM** / **Yesterday 7:00 AM**; Clock-out gets **Today 3:15 PM** / **Today 3:30 PM** / **Yesterday 3:15 PM** / **Yesterday 3:30 PM** (`quickSetAddTime(fieldId,'today'|'yesterday',hh,mm)`). The relevant button rows are toggled by `openEditModal()` (shows the 2-button edit row, hides both add-mode rows) vs. `openAddPunchModal()` (shows both add-mode rows, hides the edit row), since the modal is shared between the two flows. Existing `newOut<=newIn` / `aOut<=aIn` validation at save time already catches an inverted shift if mismatched buttons are clicked, so no extra guard was needed.
  - **Files changed:** `index.html` (removed `#master-format-picker` from `#export-confirm-modal`; added `#master-review-modal` + `#master-format-modal`; added quick-set button rows to the edit/add-punch modal; version badge). `app.js` (rewrote `openMasterExportConfirm()` + new `showMasterReviewWarning()`/`toggleMasterReviewList()`/`closeMasterReviewModal()`/`masterReviewGoNow()`/`masterReviewExportAnyway()`/`showMasterFormatModal()`/`closeMasterFormatModal()`; removed checkbox checks from `doMasterExcelZip()`; redirected its and `generateMasterPDF()`'s closing call to `closeMasterFormatModal()`; removed stale `master-format-picker` reference from `closeConfirmModal()`; `showReviewGate()` color fix; `_supLogSeq`/`_masterLogSeq` guards in `refreshSupLog()`/`refreshMasterLog()`; removed redundant call in `switchSupTab()`; new `quickSetAddTime()`/`quickSetEditOut()`; toggling added to `openEditModal()`/`openAddPunchModal()`; backup payload version).


- **v40.0 — Excel Pack export (one .xlsx per worker, zipped) — replaces the master CSV export:** A second master-admin export format that produces the GM's payroll timesheet, pre-filled, instead of the old flat CSV. The GM's downstream process is one Excel sheet per worker per pay period, so this generates one `.xlsx` per worker (matching the uploaded `Payroll_output_Sheet` template exactly — borders, legend, accounting block, `Brad Rogers`, and all pre-built K-column/Total formulas preserved) and bundles them into a single `.zip` for download. Built with **ExcelJS** (jsPDF can't write formatted Excel; SheetJS-free can't write styling) + **JSZip**, fully client-side. Approach: the blank template is embedded as base64 (`payroll-template.js`); for each worker the app reloads a fresh copy, drops values into mapped cells, and writes it back — so the GM's formatting/formulas survive untouched.
  - **Design (all confirmed with Julio before build):** scope = whatever the master log is filtered to (site/employee/date); one sheet per employee per pay period; up to 3 jobsites per week-block, up to 6 across the two weeks (week 2 can differ); each day = 2 rows for up to 2 activities with **hours split ½/½** when 2 codes (full hours on row 1 when 1 code); Job# header = the jobsite's manually-entered abbreviated name+code (`jobsites.job_number`), fallback to the site name; OT ignored; accounting summary left blank (head office).
  - **Filenames:** zip = `[Filter] - [PayPeriodEnd].zip` where Filter is the active jobsite and/or employee filter (`Site - Employee`, or just one, or `All Records` when unfiltered); each inner file = `Employee Name - [PayPeriodEnd].xlsx`. Period end = the master log "to" date; H3 (pay-period date) = the "from" date.
  - **Cell map (per sheet):** B3 name · H3 period start · B5/E5/H5 (wk1) & B24/E24/H24 (wk2) job headers · day grid rows 8–21 (wk1) / 27–40 (wk2), Sun→Sat, 2 rows each · Code/Hrs columns C/D (job1), F/G (job2), I/J (job3). Stray Julio leftovers in the "blank" template (`D43=71.5`, `G43=0` — values, not formulas) are reset at write time to `=D22+D41` / `=G22+G41` so the ST total is correct on every sheet.
  - **Overflow:** an employee with 4+ jobsites in a week gets a second file (` (2)` suffix), jobs chunked 3-per-sheet — no data dropped. Export-time notif reports how many workers hit this.
  - **Edge cases handled:** 3+ activity codes at the *same* jobsite on the *same* day (the parked GM question) → first code on row 1, the rest slash-joined on row 2, hours ½/½; logged to console. Still-clocked-in punches are skipped (no hours yet). Punches outside the 14-day grid are skipped + logged.
  - **⚠️ Known caveats flagged to Julio (not yet resolved):** (1) **Employee code (B2) is blank** — the `employees` table has no code field (`JG001`-style); B2 is wired but left empty until a code field is added or head office fills it. (2) **OT cells** — the template's OT total formulas sum the *second* row of each day; since ½-split now puts hours on row 2, the OT cells will read non-zero on any 2-activity day. Left untouched per "ignore OT"; can be neutralized to 0 on request. (3) The template was **converted .xls→.xlsx** (required — ExcelJS can't read legacy .xls); eyeball the first real export against the GM's original. (4) H3 holds the period *start date* and overwrites the "Pay Period" placeholder text, per Julio's instruction.
  - **Files changed:** `index.html` (ExcelJS+JSZip+template `<script>` tags, CSV button → Excel-pack button, version badge), `app.js` (removed `doMasterExport` CSV fn; added `doMasterExcelZip()` + helpers `_xlB64ToU8`/`_xlSanitize`/`_xlNumericCode`/`_xlRound2`; backup payload version), **new** `payroll-template.js` (embedded base64 blank template).

- **v39.1 — Custom scroll rail + tappable arrows on the activity screen:** The v39.0 full-screen checklist removed the dropdown, but Julio still wasn't getting a "this can scroll" feeling from the plain page scroll — confirmed the root cause: this screen relies on native page/PWA scrolling (no inner fixed-height box, `#app` just grows with content), and native scrollbars are essentially invisible on mobile/installed-PWA regardless of CSS styling, which is why the earlier v38.4 themed-scrollbar attempt never showed up for him either. Rather than fight native scrollbar APIs again, this builds a fully custom, self-drawn scroll-position indicator plus large tappable arrows — both driven by real `window.scrollY`/`scrollHeight`/`innerHeight` math, so they render identically everywhere instead of depending on what the OS/browser chooses to show. Per Julio's choices: arrows are tappable (auto-scroll on press, not just visual hints), and this is scoped to the clock-out activity screen only, not applied app-wide.
  - **Added:** `#act-scroll-overlay` — a `position:fixed` overlay (constrained to `#app`'s `max-width:520px` column, same centering trick as `.act-confirm-bar`) holding: `.act-scroll-rail` (a thin track + `#act-scroll-thumb`, resized/repositioned via JS to reflect actual scroll fraction — not a native scrollbar), and two 48px circular buttons (`#act-arrow-top` ▲ / `#act-arrow-bottom` ▼) that fade in only when there's content to scroll to in that direction.
  - **New JS:** `updateActScroll()` — reads `window.scrollY`, `document.documentElement.scrollHeight`, and `window.innerHeight`, sizes/positions the thumb proportionally within the rail, and toggles the `.show` class on each arrow. Guarded on `#screen-activity` actually being the active screen (cheap check up front, so it's a no-op everywhere else) and attached to `window`'s `scroll`/`resize` events. `scrollActivityBy(dir)` — what the arrows call — scrolls the page by ~60% of viewport height (`window.scrollBy({behavior:'smooth'})`), repeatable per tap.
  - **Also fixed in passing:** `showActivityScreen()` now resets `window.scrollTo(0,0)` on entry. This app's screens all share one underlying page scroll (`.screen{display:none}` just toggles which screen occupies it), so without this the activity screen could open already scrolled from whatever position a previous screen left behind — needed for the new rail/arrows to read correct state on entry, not a general app-wide scroll-reset (out of scope per "this screen only").
  - Files changed: `index.html` (new scroll-overlay markup + version badge), `styles.css` (new `.act-scroll-*` rules), `app.js` (`updateActScroll()` + `scrollActivityBy()` + scroll-reset in `showActivityScreen()` + backup payload version).


**Last session date:** June 17, 2026 (earlier in the same day)
**Tasks completed this session:**
- **v39.0 — Activity selection redesigned as a full-screen checklist (replaces the v36–v38 dropdown):** The collapsed dropdown approach (v36 original, v38.4 scrollbar+fade, v38.5 chevrons) never solved the core discoverability problem — a tiny arrow or thin scrollbar just isn't a strong enough signal on a phone someone's tapping through quickly mid-shift. Since the clock-out activity screen is already dedicated solely to this one task, the dropdown was removed entirely and replaced with the full activity checklist shown directly as the screen's main content — every activity visible in an ordinary scrolling list, no popup, no scroll-hint mechanics needed (a normal full-page scroll is something everyone already understands). Per Julio's call: the "selected activities" tag-pill summary was dropped (checkmarks in the list itself already show what's picked), and the Confirm/Cancel buttons are now pinned to the bottom of the screen in a fixed bar so they're always reachable without scrolling back down through a long activity list.
  - **Removed:** the entire v36–v38.5 dropdown mechanism — `act-dropdown-wrap/btn/list-wrap/list`, the scroll fade (`act-fade-top/bottom`), the chevrons (`act-chevron-top/bottom`), the tag pills (`act-tags`/`act-tag`), and their JS (`renderActDropdown`, `renderActTags`, `removeActTag`, `updateActDropdownLabel`, `toggleDropAct`, `toggleActDropdown`, `updateActFades`, the outside-click-to-close listener, the scroll listener).
  - **Added:** `#act-list` — a plain checklist container rendered directly in the page flow (`renderActList()`), using `.act-list-item` rows (renamed from `.act-dropdown-item`, slightly larger touch targets — 18px checkboxes, 13px row padding — since it's now the primary screen content rather than a cramped popup). Tapping a row toggles it via the new `toggleAct(name,id)` (renamed from `toggleDropAct`, simplified since there's no dropdown-open state to preserve).
  - **Added:** `.act-confirm-bar` / `.act-confirm-bar-inner` — a `position:fixed` bar pinned to the bottom of the viewport (constrained to the app's `max-width:520px` column so it doesn't span the full window on desktop test views), holding the Confirm/Cancel buttons with safe-area padding for iOS home-indicator clearance. It's nested inside `#screen-activity`, so it automatically hides along with the rest of the screen when another screen is shown (no extra JS toggle needed) — relies on the fact `#app` has no `transform`/`filter`/`contain` that would otherwise trap `position:fixed` descendants. `#screen-activity` got matching `padding-bottom:140px` so the scrollable checklist content doesn't end up hidden behind the fixed bar.
  - **Roadmap impact:** this took the v39.0 slot that had been earmarked for the per-shift lunch-waive feature — that feature is now planned for **v40.0** (see updated section below).
  - Files changed: `index.html` (activity screen markup + version badge), `styles.css` (replaced dropdown/tag rules with checklist/confirm-bar rules, including light/auto theme overrides), `app.js` (rewrote the activity-screen functions + backup payload version).


**Last session date:** June 17, 2026 (earlier in the same day)
**Tasks completed this session:**
- **v38.5 — Chevron hints added to activity dropdown scroll affordance:** Follow-up to v38.4. The scrollbar styling alone wasn't a reliable visual cue on mobile (iOS Safari ignores `::-webkit-scrollbar` styling entirely, and native scrollbars typically only render while actively touched/dragged), so a small chevron (▴ / ▾) was added at the top/bottom edge of the dropdown as a clearer, more legible "more below" signal. Driven by the same scroll-position logic as the fade, not a separate check — when there's nothing to scroll to in a direction, neither the fade nor the chevron shows.
  - **Structure:** two new sibling divs inside `#act-dropdown-list-wrap` — `#act-chevron-top` (▴) and `#act-chevron-bottom` (▾) — sitting alongside the existing fade divs.
  - **JS:** `updateActFades()` extended to toggle `.show` on the two chevrons using the same `showTop`/`showBottom` booleans already computed for the fades; no new event listeners needed.
  - Files changed: `index.html` (two new chevron divs + version badge), `styles.css` (new `.act-dropdown-chevron*` rules), `app.js` (`updateActFades()` extended + backup payload version).
- **v38.4 — Activity dropdown scroll affordance:** The clock-out activity list (`#act-dropdown-list`) only shows a handful of items before needing a scroll, but had no visible scrollbar or hint that more activities existed below — easy to miss on a phone. Added a themed, always-visible thin scrollbar (cross-browser: `scrollbar-width`/`scrollbar-color` for Firefox, `::-webkit-scrollbar*` for Chrome/Safari) plus a top/bottom fade overlay that only appears when there's actually more to scroll in that direction (computed from `scrollHeight`/`scrollTop`/`clientHeight`, not just shown statically). Purely a UX/visual fix — no change to activity data, selection logic, or how punches are saved.
  - **Structure change:** the dropdown list is now wrapped in a new `#act-dropdown-list-wrap` div, which holds the border/background/shadow/rounding and clips its contents (`overflow:hidden`); the inner `#act-dropdown-list` is just the scrolling area; two new sibling divs (`#act-fade-top` / `#act-fade-bottom`) sit on top as the fade overlays, toggled via a `.show` class.
  - **New function:** `updateActFades()` — checks if the list is actually scrollable and how far scrolled, toggles the two fade overlays accordingly. Called on render (`renderActDropdown()`), on open (`toggleActDropdown()`), and on every scroll event (listener attached once to `#act-dropdown-list`).
  - **Renamed references:** all existing show/hide logic that used to target `#act-dropdown-list` directly (`showActivityScreen()`, `toggleDropAct()`, `toggleActDropdown()`, the outside-click listener, `confirmClockOut()`) now targets `#act-dropdown-list-wrap` instead — the inner list element keeps its old ID and is otherwise untouched.
  - Files changed: `index.html` (dropdown markup + version badge), `styles.css` (new wrap/scrollbar/fade rules), `app.js` (new `updateActFades()` + wrapper-ID updates + backup payload version).
  - Note: `styles.css` was not re-uploaded in that session — edited from the project copy, later confirmed identical to Julio's actual current file when re-uploaded.


**Tasks completed this session:**
- **v38.3 — Master admin PDF export + export bug fix:** Added PDF export to the master admin report, and fixed the async bug that was causing the export to always show "No records". After confirming all 4 checkboxes and tapping "Continue →", a format picker appears in-modal with "Export PDF" and "Export CSV" buttons. PDF matches the supervisor format — one time card per page, grouped by jobsite then alphabetically by employee; same columns, colours, auto-clock footnotes and signature line. Header band reads "MASTER ADMIN EXPORT". New functions: `masterConfirmStep2()`, `generateMasterPDF()`. Updated: `openMasterExportConfirm()` (uses `_masterLogs` cache, drives step-2 flow), `closeConfirmModal()` (resets picker on close). `index.html`: added `#master-format-picker` div inside confirm modal.


**Tasks completed this session:**
- **v38.1 (this session — hotfix to v38.0 nav reorg):** The v38.0 edit had broken `index.html` structurally — master admin panel loaded blank and the supervisor screen was showing the master panel.
  - **Root cause (index.html only — `app.js`/`styles.css` were fine):** the v38.0 nav edit overwrote the supervisor dashboard *body* with the master dashboard body and deleted the `<div id="screen-master">` wrapper. Net effect: (1) the supervisor nav (`stab-live/log/employees`) and all three supervisor panels (`spanel-live`, `spanel-log`, `spanel-employees`) were gone; (2) the `</div>` closing `screen-sup` was gone; (3) `screen-master` + its "Master Administrator" header no longer existed. So `screen-sup` literally contained the master nav/panels (→ supervisor login showed the master panel), and `showScreen('screen-master')` threw on a null element (→ master never loaded).
  - **Fix:** restored the supervisor nav + `spanel-live`/`spanel-log`/`spanel-employees` verbatim (unchanged since v37.1), re-closed `screen-sup`, and re-opened a proper `screen-master` wrapper with its header around the (kept-as-is) v38.0 grouped nav and all `mpanel-*`. No JS change needed — the v38.0 `switchMasterTab` is fully null-guarded and all supervisor functions were intact; only the backup-payload version string was bumped.
  - Verified: all 6 `screen-*` containers present and open at the same DOM depth (screen-master is a sibling of screen-sup, not nested); grouped nav (`mtab-overview/manage/reporting/settings`) + both sub-rows (`#msub-manage`/`#msub-reporting`) intact; no duplicate ids; `app.js` syntax clean (node --check).
  - Files changed: `index.html` (structure + version badge), `app.js` (backup payload version only). `styles.css` unchanged.
  - Version → v38.1.
- **v38.0 (this session — admin nav reorg):** Grouped the master admin tab bar from 8 flat tabs into 4 top-level tabs to stop the horizontal scroll/cramping (admins use it on both phone and desktop). New structure: **Overview · Manage · Reporting · Settings**.
  - **Manage** group → Jobsites · Employees · Departments · Activities (opens on **Employees**). **Reporting** group → Submissions · Report (opens on **Report**). Overview and Settings stay single (no sub-row).
  - Tapping a group tab reveals a contextual sub-nav row beneath the main nav (only the active group's row shows); the parent tab shows active whenever any child is active. Pure navigation reorg — all 8 underlying panels (`mpanel-*`) are untouched.
  - **`index.html`:** replaced the flat `.nav-bar` (8 `mtab-*` buttons) with 4 top buttons (`mtab-overview/manage/reporting/settings`) + two `.subnav-bar` rows (`#msub-manage`, `#msub-reporting`) of `.subnav-btn.msub-btn` children carrying a `data-tab`. Version badge → v38.0.
  - **`app.js`:** new `MASTER_TAB_GROUP` / `MASTER_GROUP_DEFAULT` maps + `switchMasterGroup(group)` (jumps to the group's default child). `switchMasterTab` rewritten to also set the parent-group active state, show/hide the correct sub-row, and highlight the active `.msub-btn` — existing panel-show + refresh calls unchanged, so all prior callers (`switchMasterTab('log')` / `('overview')`, Overview stat-card → `('employees')`) still work. Backup payload version → v38.0.
  - **`styles.css`:** new `.subnav-bar` (banded contextual strip) + `.subnav-btn`; active state uses `var(--blue-l)` / `var(--blue-d)` — a matched light-bg/dark-text pair in BOTH themes, so no per-theme override needed (avoids the amber-style contrast inversion).
  - Verified: app.js syntax clean (node --check); no other code referenced the old per-tab `mtab-*` ids.
  - Significant change (3-file nav restructure) → whole-number bump, agreed with Julio. This claims **v38.0**, so the per-shift lunch waive arc moves to **v39.0**.
- **v37.1 (this session — critical bug fix):** Auto-clock was overwriting real clock-outs.
  - **Symptom:** since ~Jun 8–9, employees clocked out normally (saw the green confirmation, write succeeded) but the punch later showed `auto_clocked = true` with an out-time of exactly clock-in + 12h. Jun 9 hit 6/10 auto-clocked. Confirmed real (Julio saw his own punch-out succeed, then revert).
  - **Root cause:** the app is now on personal phones (NOT shared kiosks — every employee runs the PWA). Each device loads ALL open punches company-wide at boot and runs `checkAutoServer` every 30s over that in-memory list, which is never refreshed after boot. The auto-clock UPDATE had no `clock_out is null` guard, so any device still running past an employee's 12h mark would overwrite that employee's already-recorded clock-out with a 12h auto-clock. With ~50–100 phones each holding everyone's open punches, the overwrite surface was huge. NOT caused by v37.0's code (auto-clock logic was untouched) — a latent flaw whose trigger rate spiked around Jun 8–9.
  - **Fix (`app.js`, `checkAutoServer`):** the auto-clock UPDATE is now guarded with `.is('clock_out', null).select()` — it only writes if the punch is still open in the DB, so a stale device can NEVER overwrite a real clock-out. When the guarded write affects 0 rows (already closed elsewhere), it heals the stale in-memory entry from the DB (or drops it if the row was deleted). In-memory state is only marked auto-clocked when the write actually succeeds.
  - **Server-side guard (SQL, run by Julio — essential here):** because personal phones can't be force-refreshed, old cached app versions would keep overwriting until each phone updates. A `before update` trigger on `punches` blocks any update that sets `auto_clocked = true` when `clock_out` is already non-null (returns OLD), preserving the real clock-out regardless of client version. Supervisor edits set `auto_clocked = false`, so corrections are unaffected.
  - **Data cleanup:** free Supabase tier = no backups, so ~11 clock-outs overwritten Jun 8–10 are unrecoverable from backup and are being fixed manually (edit each to the real end time; supervisors distinguish true forgot-to-clock-out from overwritten ones).
  - Verified (node harness): genuinely-open punch still auto-clocks; already-clocked-out punch is preserved (not overwritten); already-auto-clocked is a no-op.
  - Version → v37.1 (`index.html` badge, `app.js` backup payload).
- **v37.0 (prior session):** Manual punch entry — create a complete punch for someone who forgot to clock in/out.
  - **DB:** new column on `punches` (SQL run by Julio): `manual_entry boolean default false`.
  - **`index.html`:** edit modal made dual-mode — added title id (`edit-modal-title`), an add-only employee `<select>` (`add-emp-select` in `add-emp-wrap`, hidden in edit mode), ids on the save button (`edit-save-btn`) and delete row (`edit-delete-wrap`). New "+ Add punch" button in both the supervisor log card and master log filters card.
  - **`app.js`:** `addingPunch` / `addPunchCtx` globals; `openAddPunchModal(ctx)` drives the shared modal in add mode (full active roster sorted by name, blank times, hides delete row, relabels save "Add punch"); `saveEdit` gained an insert branch for add mode (validates employee + clock-in + out-after-in, inserts with `manual_entry:true`, refreshes whichever log opened it); `openEditModal` now resets the modal back to edit-mode UI (shared modal); `closeEditModal` clears the add flag; `dbRowToEntry` maps `manualEntry`; both log renders prepend an amber "✎ Manual" badge when `manualEntry` is true.
  - **Design decisions (with Julio):** button in BOTH logs; supervisor employee picker is the full roster (not scoped to assigned sites); audit badge included; overlap guard skipped (future); manual marker in exports skipped (future); treated as a significant change → whole-number bump.
  - **Badge color:** fixed `#f0a830` bg / `#3a2600` text (not the `--amber` var, which inverts between light/dark themes and would lose contrast). Kept the change to `app.js` + `index.html` only — `styles.css` untouched to avoid overwriting a possibly-stale project copy.
  - Verified: app.js syntax clean; add-flow validation node-tested (blocks no-employee / no-clock-in / out-before-in; valid with both times and in-only both produce `manual_entry:true`).
  - Version → v37.0 (`index.html` badge, `app.js` backup payload).
- **v36.2 (prior session — part 3 of v36):** Automatic unpaid lunch deduction.
  - **DB:** three new columns on `pt_settings` (SQL run by Julio): `lunch_enabled` (bool, default false), `lunch_minutes` (int, default 30), `lunch_threshold_hours` (numeric, default 5).
  - **Engine** (`app.js`): lunch deduction added as the final step in `paidHours` — after credit + round, if lunch is enabled and the punch isn't auto-clocked/estimated and the adjusted elapsed hours are *greater than* the threshold, subtract `lunchMinutes/60` (floored at 0). `APP_SETTINGS` gained `lunchEnabled / lunchMinutes / lunchThresholdHours` defaults; `applySettingsRow` maps the three new columns.
  - **No per-site edits needed:** because every hours total already routes through `paidHours`, the deduction flows automatically to supervisor log, master report, export preview, CSV, and PDF. Displayed in/out times are unchanged (option-B display choice) — only the Hrs number changes.
  - **UI:** new "Unpaid lunch deduction" block in the master admin Settings tab (`set-lunch-enabled` toggle, `set-lunch-minutes`, `set-lunch-threshold` inputs); `refreshSettingsPanel` populates them, `saveSettings` reads + upserts them.
  - Verified math (node harness): 7:00–3:30 (8.5h) → 8.0h; exactly 5h → no deduction (over-threshold, not at); 5.5h → 5.0h; 4h short shift untouched; auto-clocked 12h and estimated 9h left exact; disabled → no change.
  - Threshold uses *over* (`>`) not *at-or-over* — a shift of exactly 5h is not docked. Decided with Julio.
  - Version → v36.2 (`index.html` badge, `app.js` backup payload).
- **v36.1 (prior session — part 2 of v36):** Configurable pay rules — admin-controlled rounding + paid break-in-lieu credit.
  - **DB:** new `pt_settings` table (single row id=1) — namespaced to avoid collision with an unrelated `settings` table already in the project (JEG's Designs). SQL run by Julio. Holds `rounding_enabled / rounding_minutes / sched_end_enabled / sched_end_time / sched_end_window`.
  - **Engine** (`app.js`, near the time helpers): `applySettingsRow`, `roundTime` (local-clock nearest-interval, timezone-safe), `applySchedEnd` (credit up to scheduled end, no clipping), `adjustedTimes` (credit-then-round; skips auto-clocked + estimated), `paidHours`. `APP_SETTINGS` global with safe defaults; loaded in `bootApp` (defaults persist if row/table missing).
  - **Wired `paidHours` / `adjustedTimes` into every hours site:** supervisor log total + per-punch (raw times kept on screen), master report preview + table (raw times on screen), supervisor export preview total, master CSV export (adjusted times + paid hrs), PDF `consolidate` + rows + total (adjusted times + paid hrs). Auto-clock detection, live "elapsed" timer, and estimate-modal preview deliberately stay on RAW time.
  - **UI:** new master admin **Settings** tab (`mtab-settings` / `mpanel-settings`) with both rule toggles + inputs; `refreshSettingsPanel` populates from `APP_SETTINGS`, `saveSettings` upserts the row and updates the device immediately. `switchMasterTab` extended with `'settings'`.
  - Verified math (node harness): 7:00→3:15 credits to 3:30 (8.5h elapsed); 3:45 not clipped; 2:00 early-leave gets no credit; 7/8 rounding boundaries correct; auto-clocked punches unaffected by rules.
  - **Display choice (option B):** on-screen review tables show real punch times with paid hours in the Hrs column; edit modal still edits the true punch. PDF/CSV show adjusted times so the deliverable reconciles.
  - **Known gap by design:** no lunch deduction yet → a normal 7:00–3:30 day reads 8.5h. The 30-min unpaid lunch that brings it to 8.0h is v36.2.
  - Version → v36.1 (`index.html` badge, `app.js` backup payload).
- **v36.0 (prior session — part 1 of v36):** Review gate on supervisor report submission.
  - A supervisor can no longer submit a report (preliminary OR final) while any punch in the selected date range + jobsites is still auto-clocked (`auto_clocked = true`). The gate runs at the very start of the export flow, before the duplicate-check and estimated-clock-out steps.
  - On a blocked attempt, a new modal (`#review-gate-bg`) lists the affected employees and their clock-in times. "Review these now" closes the export and calls `goToSupReport('review')`, dropping the Time log into the needs-review filter so they can fix each one. "Cancel" backs out.
  - Because punches are re-fetched on every export attempt and editing an auto-clock flips `auto_clocked → false`, the gate clears itself as each one is resolved — no new data model.
  - **Master admin export is intentionally not gated** — admin can submit regardless (override).
  - `index.html`: added `#review-gate-bg` modal (after the dup modal); version badge → v36.0.
  - `app.js`: gate block added in `openExportConfirm` after the punch fetch; new `showReviewGate()` / `closeReviewGate()` / `reviewGateGoNow()`; backup payload version → v36.0.
  - **Shipped in v36.1 (part 2):** configurable rounding + paid break-in-lieu credit (see v36.1 entry above).
- **v35.7:** Two contained feature additions ahead of the Monday reporting period.
  - **Supervisor permissions:** supervisors can no longer change *other* supervisors' kiosk PIN or login password — admin only. They can still change their own and manage regular employees.
    - `index.html`: added `id="emp-sup-pass-field"` to the password field wrapper; added `#emp-restrict-note` lock message under the PIN field.
    - `app.js`: `refreshSupEmps` hides Reset PIN for other supervisors; `openEmpModal` locks the PIN field + hides the password field + shows the note when a supervisor edits another supervisor (`ctx==='sup'`); `saveEmployee` preserves the existing PIN/password in that case (DOM-tamper guard).
    - Note: this is a UI-level guard. Supabase anon key still allows direct DB writes — server-side enforcement waits on the RLS work (see short-list).
  - **Clickable Live tiles:** the three supervisor Live tiles are now tappable and jump to the Time log with the matching view.
    - `index.html`: added `onclick="goToSupReport(...)"` + pointer cursor to the three tiles; added the `s-filter-flags` dropdown to the Time log period selector.
    - `app.js`: new `goToSupReport(which)`; `refreshSupLog` now reads `s-filter-flags` — `review` runs a period-independent query for all outstanding auto-clocked+uncorrected punches (matches the tile count), `stillin` filters the date-bounded results to open punches; `setSupPeriod` clears the filter when a period button is clicked. Export preview is untouched (it queries independently by date).
  - Version bumped in `app.js` (backup payload) and `index.html` (version badge).
- **v35.6:** Session persistence improved for personal phone use.
  - Switched `pt_session` from `sessionStorage` → `localStorage` so session survives tab close, app backgrounding, and returning from the kiosk screen.
  - Extended session expiry from 10 minutes → **8 hours** (`SESSION_PERSIST_MS`).
  - Session timestamp now **refreshes on every user interaction** (inside `resetSupTimer` and `resetMasterTimer`) so an active user never hits the wall mid-shift.
  - Explicit logout (back to kiosk button or inactivity timeout) still clears `localStorage` as before.
  - Changes in `app.js`: `tryRestoreSession`, `resetSupTimer`, `resetMasterTimer`, `masterLogin`, `supLogin`.
  - Version bumped in `app.js` (backup payload) and `index.html` (version badge).

- **v35.5:** Master admin Employees tab — removed the Status column. Inactive employees now show "(inactive)" in grey next to their name. The Deactivate/Activate toggle button is now colour-coded: red when active (Deactivate), green when inactive (Activate). Changes in `app.js` (`refreshMasterEmps`) and `index.html` (table header).
- **v35.4:** PanoramaTrack logo is now clickable in the supervisor dashboard header and master admin dashboard header — clicking it navigates back to the kiosk screen.
- Fixed version display: was incorrectly showing `v36` — corrected to `v35.1` in both `index.html` and `app.js`
- Confirmed no material ordering system remnants remain in the codebase
- Version increment rules established and documented above
- **v35.2:** Master admin Report tab now defaults to current pay period on open. Replaced quick-select buttons with supervisor-style period buttons (Today / Yesterday / Current period / Last period / 2 periods ago).
- **v35.3:** Fixed Report tab filter reset behaviour in master admin panel.

**Status:** App fully working.

---

## 🐛 Known Bugs / Open Issues

- [x] **RESOLVED v37.1** — Auto-clock overwriting real clock-outs (see v37.1 task log). Fixed client-side (guarded update) + server-side (trigger). After deploy, employees' PWAs update on their own schedule; the DB trigger protects data in the meantime.
- [ ] **OPEN — Supabase RLS disabled (security).** Supabase flagged `punches` (and likely other tables) as publicly readable/writable because Row-Level Security is off — anyone with the project URL could read/edit/delete data. NOT the cause of the auto-clock bug (ruled out). Do NOT click "Resolve issue" / enable RLS without policies first — with the anon key and no policies it will take the whole app offline. Needs a deliberate pass: enable RLS + add policies (or move writes behind a server function) and rotate keys. Parked until the dust settles on v37.1.
- [ ] Manual cleanup of ~11 clock-outs overwritten Jun 8–10 (no backups on free tier — reconstruct from supervisor/employee knowledge via the edit modal).

---

## 💡 Next Features Planned

_(Full roadmap is in `PanoramaTrack_Future_Features.md`)_

**Priority short-list:**
- [ ] Tighten Supabase RLS policies (anon key currently allows full DB read/write)
- [ ] Kiosk lock screen — return to PIN entry after inactivity
- [ ] Hash employee PINs (currently plaintext in DB)

---

## ⏭ Next Session Agenda

**Per-shift lunch waive — ✅ SHIPPED in v42.0.** (See the v42.0 entry under "What Was Last Being Worked On" for the full design + build record.) The lunch arc is now complete: auto-deduction (v36.2) + per-shift waive request/approval (v42.0).

No feature is currently mid-flight. Candidate next items, none committed:
- **Per-shift lunch waive — possible follow-ups if they come up in use:** surface the waive toggle in the My Timecard self-edit path too (deliberately left out of v42.0); a "deny all" bulk action (deliberately left individual); a waive marker in PDF/CSV/Excel exports (currently the badge is on-screen only — the *effect* on paid hours already flows through exports via `paidHours`, but there's no visible "waived" annotation on the exported timesheet).
- **NFC tag scanning** — explored as a PIN alternative; Web NFC works on Android Chrome, not iOS Safari. Parked, no decision.
- **Codebase file-splitting** — plain `<script>`-tag splitting (no bundler); export functions the natural first candidate. Discussed, not actioned.

See the Security / Priority short-list below for the standing open items (RLS, kiosk lock screen, PIN hashing).

---

## 🔑 Key Code Locations (in app.js)

| Feature | Function / search term |
|---|---|
| Clock-in flow | `clockIn()` |
| Clock-out flow | `clockOut()` |
| Auto-clock logic | `checkAutoServer()` / `AUTO_H=12`; runs every 30s (`setInterval` ~line 163). v37.1: write guarded with `.is('clock_out',null)` so it can't overwrite a real clock-out; also a DB `before update` trigger on `punches` blocks auto_clock writes onto already-closed punches |
| PDF generation | `generatePDF()` |
| Pay period calc | `getPayPeriod()` / `getPeriodByOffset()` |
| Submission tracking | `refreshSubmissionsPanel()` |
| Supervisor login | `activeSup` variable |
| DB init / boot | `bootApp()` |
| Export confirm flow | `openExportConfirm()` |
| Activity code lookup | `actCodeMap` / `formatTaskCode()` |
| Activity full-screen checklist (v39.0, replaces v36–v38 dropdown) | `showActivityScreen()` / `renderActList()` / `toggleAct(name,id)`; `#act-list` (checklist container), `.act-list-item` rows, `#activity-error`; fixed bottom bar `.act-confirm-bar`/`.act-confirm-bar-inner` holding Confirm/Cancel — all in `#screen-activity` in index.html; `.act-list*`/`.act-confirm-bar*` in styles.css |
| Activity screen custom scroll rail + tappable arrows (v39.1) | `updateActScroll()` / `scrollActivityBy(dir)`; `#act-scroll-overlay` (`.act-scroll-rail`/`#act-scroll-thumb`, `#act-arrow-top`/`#act-arrow-bottom`) in index.html; `.act-scroll-*` in styles.css |
| Supabase client | Top of `app.js` — `SUPABASE_URL` / `SUPABASE_KEY` |
| Theme toggle | `applyTheme()` / `setTheme()` / `pt-theme` (localStorage) |
| Backup | `runBackup()` |
| Corfix reminder | `showCorfixReminder()` / `JOBSITE_DATA` |
| Master report period select | `setMasterPeriod(mode)` / `_masterPeriodMode` |
| Supervisor period select | `setSupPeriod(mode)` / `_supPeriodMode` |
| Session persistence | `tryRestoreSession()` / `SESSION_PERSIST_MS` / `pt_session` (localStorage) |
| Supervisor permission gating | `refreshSupEmps()` / `openEmpModal(id,ctx)` / `saveEmployee()` — `restricted` flag; `#emp-sup-pass-field`, `#emp-restrict-note` in index.html |
| Live tile navigation | `goToSupReport(which)` → `setSupPeriod` + `s-filter-flags` + `refreshSupLog` |
| Submit review gate | `openExportConfirm()` (gate block) → `showReviewGate(autoList,waiveList)` / `closeReviewGate()` / `reviewGateGoNow()`; `#review-gate-bg` (two sections: `#review-gate-auto-section`/`#review-gate-list` + `#review-gate-waive-section`/`#review-gate-waive-list`) in index.html. v42.0: gate now also blocks on pending lunch waives, with bulk `approveAllWaivesFor(empId)`. Master path is intentionally not blocking — see "Master export review warning (v40.1)" row below |
| Lunch waive — capture (v42.0) | `#lunch-waive-row`/`#lunch-waive-chk` toggle at top of `#screen-activity` (above `#act-list`) in index.html; `lunchWaiveRequested` global + `toggleLunchWaive()`; reset in `showActivityScreen()`; written in `confirmClockOut()` (`lunch_waive_requested` column) |
| Lunch waive — approval (v42.0) | edit modal `#edit-waive-wrap` (Approve/Deny → `setEditWaive(bool)` / `_renderEditWaive()` / `setupEditWaive(entry)`, `_editWaiveDecision` global); persisted in `saveEdit()` when `_editWaiveDecision!==null` (`lunch_waived` column); hidden in Add-Punch mode. Bulk approve from the gate: `approveAllWaivesFor(empId)` (`_reviewGateWaives`) |
| Lunch waive — engine/surfacing (v42.0) | `paidHours()` skips deduction when `lunchWaived===true`; `isPendingWaive(entry)` = `requested===true && waived==null` (single source for gate/filter/tile); `dbRowToEntry()` maps `lunchWaiveRequested`/`lunchWaived`; supervisor `review` filter `.or(...)` + `refreshSupLive` second count include pending waives; 🍴 status chips in `refreshSupLog`/`refreshMasterLog` |
| Edit punch (existing) | `openEditModal(ref)` / `saveEdit()` / `confirmDeletePunch()` / `deletePunch()`; `#edit-modal-bg` in index.html |
| Manual add punch (v37.0) | `openAddPunchModal(ctx)` + add branch at top of `saveEdit()`; shared edit modal in add mode (`addingPunch` / `addPunchCtx` globals); "+ Add punch" buttons in `#spanel-log` & `#mpanel-log`; `manual_entry` column; amber "✎ Manual" badge in `refreshSupLog`/`refreshMasterLog` |
| Master grouped nav (v38.0) | `switchMasterGroup(group)` / `switchMasterTab(tab)` (rewritten) / `MASTER_TAB_GROUP` + `MASTER_GROUP_DEFAULT`; top tabs `#mtab-overview/manage/reporting/settings`, sub-rows `#msub-manage` / `#msub-reporting` holding `.subnav-btn.msub-btn[data-tab]` in index.html; `.subnav-bar` / `.subnav-btn` in styles.css |
| Pay rules engine | `APP_SETTINGS` (global) / `applySettingsRow()` / `roundTime()` / `applySchedEnd()` / `adjustedTimes()` / `paidHours()` (lunch deduction lives here, v36.2; skipped per-punch when `lunchWaived===true`, v42.0) — near the time helpers (`fmtDt` area) |
| Pay rules settings UI | `refreshSettingsPanel()` / `saveSettings()`; `mtab-settings` + `mpanel-settings` in index.html; `pt_settings` table in Supabase |
| Hours display sites (use paidHours) | `refreshSupLog`, `refreshMasterLog`, `updateExportPreview`, `doMasterExcelZip` (Excel pack), `generatePDF` `consolidate` |
| Excel Pack export (v40.0) | `doMasterExcelZip()` + helpers `_xlB64ToU8` / `_xlSanitize` / `_xlNumericCode` / `_xlRound2`; embedded template in `payroll-template.js` (`window.PAYROLL_TEMPLATE_B64`); ExcelJS+JSZip `<script>` tags in index.html. Replaces the old `doMasterExport` CSV fn. |
| Master export review warning + format picker (v40.1) | `openMasterExportConfirm()` → `showMasterReviewWarning()` / `toggleMasterReviewList()` / `closeMasterReviewModal()` / `masterReviewGoNow()` / `masterReviewExportAnyway()` (`#master-review-modal`) → `showMasterFormatModal()` / `closeMasterFormatModal()` (`#master-format-modal`, holds the 📄 PDF / 📦 Excel Pack buttons). Replaces the old shared `chk1`–`chk4` checklist for the admin path; supervisor's checklist/review-gate unaffected. |
| Quick-set time buttons (v40.1) | `quickSetEditOut(hh,mm)` (Edit Punch — same date as current clock-in) / `quickSetAddTime(fieldId,'today'\|'yesterday',hh,mm)` (Add Manual Punch); button rows `#out-quickset-edit` / `#in-quickset-add` / `#out-quickset-add` in index.html, toggled by `openEditModal()` / `openAddPunchModal()` |
| Needs-review race guard (v40.1) | `_supLogSeq` in `refreshSupLog()`, `_masterLogSeq` in `refreshMasterLog()` — sequence-number guard so a stale, superseded call can't overwrite a newer one's render |
| My Timecard — employee self-edit (v41.0) | `submitTimecardPin()` → `openMyTimecard(emp)` / `closeMyTimecard()` / `renderMyTcList()`; edit & add via shared `openMyTcEdit(dbId)` / `openMyTcAdd()` → `saveMyTcEdit()` (`#mytc-edit-modal-bg`, separate from the supervisor/master `#edit-modal-bg`); `buildMyTcActGrid()`/`toggleMyTcAct()`; "My Timecard" button + `#screen-mytc` in index.html; writes `manual_entry=true` (no new flag); period-lock check queries `submissions` for a `final` row overlapping `getPeriodByOffset(0)`
| Supervisor log filter | `refreshSupLog()` reads `#s-filter-flags` (`''` / `stillin` / `review`) |
| Version display | `index.html` version badge `<div>` (~line 195, top-left of `#screen-kiosk`) and `app.js` backup payload (`app_version`) |

---

## 📋 How to Start a New Chat

Paste this at the top of your first message:

> "I'm continuing development on PanoramaTrack. Please read CURRENT_STATE.md and the project files to get up to speed. Here's what I need help with today: [your task]"

---

_Last updated: June 30, 2026 — v42.2_
