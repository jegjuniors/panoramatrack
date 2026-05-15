# PanoramaTrack — Current State

**Current Version:** v35.6
**Last Updated:** May 14, 2026

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

---

## 🚧 What Was Last Being Worked On

**Last session date:** May 14, 2026
**Tasks completed this session:**
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
| Version display | `index.html` line ~152 and `app.js` backup payload |

---

## 📋 How to Start a New Chat

Paste this at the top of your first message:

> "I'm continuing development on PanoramaTrack. Please read CURRENT_STATE.md and the project files to get up to speed. Here's what I need help with today: [your task]"

---

_Last updated: May 14, 2026 — v35.6_
