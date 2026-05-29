# PanoramaTrack — Current State

**Current Version:** v36.1
**Last Updated:** May 29, 2026

---

## 🗂 File Structure

| File | Purpose |
|---|---|
| `index.html` | All UI markup, modals, screens |
| `app.js` | All logic, Supabase calls, state |
| `styles.css` | All styling |
| `CURRENT_STATE.md` | This file — project state tracker |
| `PanoramaTrack_Future_Features.md` | Roadmap / future ideas |

---

## 🗄 Database (Supabase)

**Tables:** `employees`, `jobsites`, `departments`, `activities`, `punches`, `submissions`, `pt_settings`

`pt_settings` (added v36.1) is a single config row (`id = 1`) holding app-wide pay rules: `rounding_enabled`, `rounding_minutes`, `sched_end_enabled`, `sched_end_time`, `sched_end_window`. Loaded on boot into `APP_SETTINGS`; edited in the master admin Settings tab. Rules are display/export-only — punch rows are never modified.

Supervisors are employees with `dept = 'Supervisor'`. Supervisor password stored in `supervisor_password` column. Supervisor jobsite assignments stored in `supervisor_jobsites` (text array).
No separate supervisors table.

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
- **Review gate on supervisor submit** — a supervisor cannot submit a report (preliminary OR final) while any punch in the selected range is still auto-clocked. A blocking modal lists the affected employees + clock-in times; "Review these now" jumps the Time log into the needs-review filter to fix them. The gate clears automatically as each auto-clock is edited to a real clock-out. Master admin export is intentionally NOT gated (admin override)
- **Configurable pay rules (master admin Settings tab, v36.1)** — two admin-toggleable rules, both Supabase-backed (shared across devices) and display/export-only (raw punches untouched):
  - **Punch-time rounding** — rounds each clock-in/out to nearest 15 / 6 / 5 min (neutral nearest-mark / 7-8 rule). Default 15 min, off by default.
  - **Paid break-in-lieu credit** — clock-outs within a window (default 15 min) before a scheduled end (default 3:30 PM) are paid to the scheduled end; later punch-outs are never clipped. Off by default.
  - Applied credit-then-round. Auto-clocked and estimated punches are always left exact. On-screen review tables show RAW times with PAID hours; PDF/CSV exports show ADJUSTED times + paid hours. NOTE: the 30-min unpaid lunch deduction is NOT part of v36.1 — that's v36.2 — so a 7:00–3:30 day currently reads 8.5h, not 8.0h.

---

## 🚧 What Was Last Being Worked On

**Last session date:** May 29, 2026
**Tasks completed this session:**
- **v36.1 (this session — part 2 of v36):** Configurable pay rules — admin-controlled rounding + paid break-in-lieu credit.
  - **DB:** new `pt_settings` table (single row id=1) — namespaced to avoid collision with an unrelated `settings` table already in the project (JEG's Designs). SQL run by Julio. Holds `rounding_enabled / rounding_minutes / sched_end_enabled / sched_end_time / sched_end_window`.
  - **Engine** (`app.js`, near the time helpers): `applySettingsRow`, `roundTime` (local-clock nearest-interval, timezone-safe), `applySchedEnd` (credit up to scheduled end, no clipping), `adjustedTimes` (credit-then-round; skips auto-clocked + estimated), `paidHours`. `APP_SETTINGS` global with safe defaults; loaded in `bootApp` (defaults persist if row/table missing).
  - **Wired `paidHours` / `adjustedTimes` into every hours site:** supervisor log total + per-punch (raw times kept on screen), master report preview + table (raw times on screen), supervisor export preview total, master CSV export (adjusted times + paid hrs), PDF `consolidate` + rows + total (adjusted times + paid hrs). Auto-clock detection, live "elapsed" timer, and estimate-modal preview deliberately stay on RAW time.
  - **UI:** new master admin **Settings** tab (`mtab-settings` / `mpanel-settings`) with both rule toggles + inputs; `refreshSettingsPanel` populates from `APP_SETTINGS`, `saveSettings` upserts the row and updates the device immediately. `switchMasterTab` extended with `'settings'`.
  - Verified math (node harness): 7:00→3:15 credits to 3:30 (8.5h elapsed); 3:45 not clipped; 2:00 early-leave gets no credit; 7/8 rounding boundaries correct; auto-clocked punches unaffected by rules.
  - **Display choice (option B):** on-screen review tables show real punch times with paid hours in the Hrs column; edit modal still edits the true punch. PDF/CSV show adjusted times so the deliverable reconciles.
  - **Known gap by design:** no lunch deduction yet → a normal 7:00–3:30 day reads 8.5h. The 30-min unpaid lunch that brings it to 8.0h is v36.2.
  - Version → v36.1 (`index.html` badge, `app.js` backup payload).
- **v36.0 (earlier this session — part 1 of v36):** Review gate on supervisor report submission.
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

- [ ] None currently logged — add any you discover here

---

## 💡 Next Features Planned

_(Full roadmap is in `PanoramaTrack_Future_Features.md`)_

**Priority short-list:**
- [ ] Tighten Supabase RLS policies (anon key currently allows full DB read/write)
- [ ] Kiosk lock screen — return to PIN entry after inactivity
- [ ] Hash employee PINs (currently plaintext in DB)

---

## ⏭ Next Session Agenda — v36.2: Lunch handling

The pay rules (v36.1) are in. The remaining v36 work is lunch, in two parts. Design questions still OPEN — settle at the start.

**1. Automatic lunch deduction (net-new pay logic):**
- Subtract an unpaid lunch (default 30 min) when a shift exceeds a threshold. Alberta requires a 30-min break after 5 consecutive hours.
- Decide: exact threshold (e.g. shift > 5h), deduction length, and whether it's admin-configurable in the Settings tab (likely yes, alongside the other rules).
- This is what makes a normal 7:00–3:30 day read **8.0h** instead of the current 8.5h. Order with existing rules: deduction applies to worked time; sched-end credit + rounding already settled as credit-then-round — slot lunch deduction in and re-verify the 8.0h target.

**2. Per-shift lunch-waive toggle (worked-through-lunch case):**
- Employee works through lunch, leaves ~30 min early (2:45), should NOT be docked the 30 min.
- Needs a new boolean column on `punches` (e.g. `lunch_waived`) — it's a per-day decision, not a permanent trait. **DB migration required** (Julio runs it).
- OPEN: who sets it and where? ("we typically allow when they ask" → discretionary, not self-serve). Options: supervisor sets it on the punch; or employee requests at clock-out, flagged for supervisor review. Per-employee default too, or purely per-shift?

Relevant code: `paidHours` / `adjustedTimes` (slot the lunch math here), `APP_SETTINGS` + Settings tab (add lunch config), `dbRowToEntry` + `clockOut` + edit modal (for `lunch_waived`).

---

## 🔑 Key Code Locations (in app.js)

| Feature | Function / search term |
|---|---|
| Clock-in flow | `clockIn()` |
| Clock-out flow | `clockOut()` |
| Auto-clock logic | `checkAutoClockOut()` / `AUTO_H=12` |
| PDF generation | `generatePDF()` |
| Pay period calc | `getPayPeriod()` / `getPeriodByOffset()` |
| Submission tracking | `refreshSubmissionsPanel()` |
| Supervisor login | `activeSup` variable |
| DB init / boot | `bootApp()` |
| Export confirm flow | `openExportConfirm()` |
| Activity code lookup | `actCodeMap` / `formatTaskCode()` |
| Supabase client | Top of `app.js` — `SUPABASE_URL` / `SUPABASE_KEY` |
| Theme toggle | `applyTheme()` / `setTheme()` / `pt-theme` (localStorage) |
| Backup | `runBackup()` |
| Corfix reminder | `showCorfixReminder()` / `JOBSITE_DATA` |
| Master report period select | `setMasterPeriod(mode)` / `_masterPeriodMode` |
| Supervisor period select | `setSupPeriod(mode)` / `_supPeriodMode` |
| Session persistence | `tryRestoreSession()` / `SESSION_PERSIST_MS` / `pt_session` (localStorage) |
| Supervisor permission gating | `refreshSupEmps()` / `openEmpModal(id,ctx)` / `saveEmployee()` — `restricted` flag; `#emp-sup-pass-field`, `#emp-restrict-note` in index.html |
| Live tile navigation | `goToSupReport(which)` → `setSupPeriod` + `s-filter-flags` + `refreshSupLog` |
| Submit review gate | `openExportConfirm()` (gate block) → `showReviewGate()` / `closeReviewGate()` / `reviewGateGoNow()`; `#review-gate-bg` in index.html. Master path (`openMasterExportConfirm`) is NOT gated |
| Pay rules engine | `APP_SETTINGS` (global) / `applySettingsRow()` / `roundTime()` / `applySchedEnd()` / `adjustedTimes()` / `paidHours()` — near the time helpers (`fmtDt` area) |
| Pay rules settings UI | `refreshSettingsPanel()` / `saveSettings()`; `mtab-settings` + `mpanel-settings` in index.html; `pt_settings` table in Supabase |
| Hours display sites (use paidHours) | `refreshSupLog`, `refreshMasterLog`, `updateExportPreview`, `doMasterExport` (CSV), `generatePDF` `consolidate` |
| Supervisor log filter | `refreshSupLog()` reads `#s-filter-flags` (`''` / `stillin` / `review`) |
| Version display | `index.html` line ~153 and `app.js` backup payload |

---

## 📋 How to Start a New Chat

Paste this at the top of your first message:

> "I'm continuing development on PanoramaTrack. Please read CURRENT_STATE.md and the project files to get up to speed. Here's what I need help with today: [your task]"

---

_Last updated: May 29, 2026 — v36.1_
