# PanoramaTrack — Current State

**Current Version:** v35.7
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

**Tables:** `employees`, `jobsites`, `departments`, `activities`, `punches`, `submissions`

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

---

## 🚧 What Was Last Being Worked On

**Last session date:** May 29, 2026
**Tasks completed this session:**
- **v35.7 (this session):** Two contained feature additions ahead of the Monday reporting period.
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

## ⏭ Next Session Agenda — Time Rounding + Export (do together, before Monday)

These two belong in one session because rounded times need to flow into the export. Design questions to settle at the start:

**Time rounding** (net-new — not in codebase or roadmap yet; highest-stakes change since it affects pay):
- Rounding rule? Options: nearest quarter-hour (7-minute rule), nearest tenth of an hour (6 min), or clock-in rounds up / clock-out rounds down with a grace window.
- Per-punch (round in and out separately) or applied to the daily/period total?
- Display/export-only (raw punches stay intact in the DB, rounding is a transform — recommended) vs. storing rounded values?

**Export** (PDF already works — preliminary + final, with activity codes):
- What needs to change — a new format (CSV for payroll/accounting), a layout change, or just surfacing the rounded times in the existing PDF?

Relevant code to reread: `getPeriodByOffset`, `fetchExportLogs`, `updateExportPreview`, `openExportConfirm`, `generatePDF`.

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
| Supervisor log filter | `refreshSupLog()` reads `#s-filter-flags` (`''` / `stillin` / `review`) |
| Version display | `index.html` line ~153 and `app.js` backup payload |

---

## 📋 How to Start a New Chat

Paste this at the top of your first message:

> "I'm continuing development on PanoramaTrack. Please read CURRENT_STATE.md and the project files to get up to speed. Here's what I need help with today: [your task]"

---

_Last updated: May 29, 2026 — v35.7_
