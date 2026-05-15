# PanoramaTrack — Current State & Handoff Note

> **How to use this file:** Update this at the end of each chat session before you run out of space.
> Add it to your Claude Project so every new chat starts with full context.
> Replace placeholder sections with your latest notes.

---

## 🗂️ Project Overview

**App:** PanoramaTrack — Employee time tracking PWA for Panorama Building Systems
**Stack:** `index.html` + `styles.css` + `app.js` (vanilla JS) + Supabase backend
**Hosting:** Netlify (auto-deploys from GitHub on push) — installable PWA on tablet/phone
**GitHub repo:** https://github.com/jegjuniors/panoramatrack (private)
**Master password:** `master2024`
**Auto-clock rule:** Open punches auto-clock out at 12 hours
**Current version:** v35.4

### ⚠️ File Structure (split as of May 14, 2026)
The app was previously a single `index.html`. It is now 3 files:
| File | Contents |
|---|---|
| `index.html` | HTML shell only — markup, links to styles.css and app.js |
| `styles.css` | All CSS styles |
| `app.js` | All JavaScript (~2,515 lines) |

**When making changes:** Claude only needs to read/edit the relevant file. Most changes will be to `app.js` only.

**Version rule:** Minor changes = increment by 0.1 (e.g. v35.1 → v35.2). Significant changes = confirm first, increment by whole number. Version appears in two places:
- `index.html` line ~152 — kiosk screen display: `>v35.4</div>`
- `app.js` line ~2338 — backup payload: `app_version:'v35.4'`

---

## 🔄 Dev Workflow

1. Start chat, describe what's needed
2. Claude edits the relevant file and provides updated version
3. Replace file locally
4. `git add . && git commit -m "description" && git push`
5. Netlify auto-deploys in ~30 seconds

---

## 🗄️ Supabase Tables

| Table | Purpose |
|---|---|
| `punches` | Clock-in/out records (`clock_in`, `clock_out`, `jobsite`, `activities`, `auto_clocked`) |
| `employees` | Employee records (`name`, `pin`, `department`, `active`, `supervisor_password`, `supervisor_jobsites`) |
| `activities` | Activity codes with `sort_order` and `active` flag |
| `jobsites` | Jobsite list with `active`/`archived` state, plus `address`, `gc`, `job_number`, `corfix_url` fields |
| `submissions` | Export submission records (`employee_id`, `period_start`, `period_end`, `submitted_by`, `status`: `preliminary` or `final`) |

> Note: Supervisors are employees where `department = 'Supervisor'`. No separate supervisors table.

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

---

## 🚧 What Was Last Being Worked On

**Last session date:** May 14, 2026
**Tasks completed this session:**
- **v35.4:** PanoramaTrack logo is now clickable in the supervisor dashboard header and master admin dashboard header — clicking it navigates back to the kiosk screen. (`onclick="showKiosk()"` + `cursor:pointer` added to both header logos at lines 241 and 335 in `index.html`).
- Fixed version display: was incorrectly showing `v36` — corrected to `v35.1` in both `index.html` and `app.js`
- Confirmed no material ordering system remnants remain in the codebase (was previously started and abandoned — already fully removed)
- Version increment rules established and documented above
- **v35.2:** Master admin Report tab now defaults to current pay period on open. Replaced quick-select buttons (Today / Last 7 days / Last 14 days / All time) with supervisor-style period buttons (Today / Yesterday / Current period / Last period / 2 periods ago), with matching active-highlight behaviour. Old `setMasterLogPeriod()` replaced by `setMasterPeriod(mode)` mirroring `setSupPeriod()`.
- **v35.3:** Fixed Report tab filter reset behaviour in master admin panel:
  - Clicking the Report tab via the nav bar now resets all filters (jobsite → All, employee → All, flags → All records) and defaults to current pay period.
  - "Clocked in now" tile now correctly highlights the **Today** button (previously Current Period stayed highlighted even though date range was set to today).
  - "Needs review" tile correctly sets flags filter to "Needs review only" — all other entry points always reset it to "All records".
  - Site card clicks from the overview now correctly use today's date with Today button highlighted, plus the site pre-selected.

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
| DB init / boot | `initApp()` |
| Export confirm flow | `openExportConfirm()` |
| Activity code lookup | `actCodeMap` / `formatTaskCode()` |
| Supabase client | Top of `app.js` — `SUPABASE_URL` / `SUPABASE_KEY` |
| Theme toggle | `applyTheme()` / `setTheme()` / `pt-theme` (localStorage) |
| Backup | `runBackup()` |
| Corfix reminder | `showCorfixReminder()` / `JOBSITE_DATA` |
| Master report period select | `setMasterPeriod(mode)` / `_masterPeriodMode` |
| Supervisor period select | `setSupPeriod(mode)` / `_supPeriodMode` |
| Version display | `index.html` line ~152 and `app.js` line ~2338 |

---

## 📋 How to Start a New Chat

Paste this at the top of your first message:

> "I'm continuing development on PanoramaTrack. Please read CURRENT_STATE.md and the project files to get up to speed. Here's what I need help with today: [your task]"

---

_Last updated: May 14, 2026 — v35.4_
