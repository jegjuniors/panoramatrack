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

### ⚠️ File Structure (split as of May 14, 2026)
The app was previously a single `index.html`. It is now 3 files:
| File | Contents |
|---|---|
| `index.html` | HTML shell only — markup, links to styles.css and app.js |
| `styles.css` | All CSS styles |
| `app.js` | All JavaScript (~2,500 lines) |

**When making changes:** Claude only needs to read/edit the relevant file. Most changes will be to `app.js` only.

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
| `jobsites` | Jobsite list with `active`/`archived` state |
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
- Dark/light/auto theme toggle
- PWA manifest + installable on iOS/Android
- PDF export with activity codes (e.g. `41-001 (Interior Steel)`)
- Preliminary export allowed for in-progress periods
- Multi-period view in supervisor log (Today / Yesterday / Current / Last / 2 periods ago)

---

## 🚧 What Was Last Being Worked On

**Last session date:** May 14, 2026
**Task in progress:** Workflow improvements — split monolithic index.html into 3 files, set up GitHub repo, connected Netlify auto-deploy
**Status:** App fully working. No feature changes made. Workflow significantly improved.

**Key changes made:**
- Split `index.html` into `index.html` + `styles.css` + `app.js`
- Created GitHub repo (jegjuniors/panoramatrack, private)
- Connected Netlify to GitHub for auto-deploy on push
- Git installed on developer's Windows machine

**Known issue / next step:**
- Fill in your top priority feature from the roadmap here before starting next chat

---

## 🐛 Known Bugs / Open Issues

- [ ] None currently logged — add any you discover here

---

## 💡 Next Features Planned

_(Full roadmap is in `PanoramaTrack_Future_Features.md`)_

**Priority short-list:**
- [ ] Tighten Supabase RLS policies (anon key currently allows full DB read/write)
- [ ] In-app "Backup Now" button in master admin panel
- [ ] Kiosk lock screen — return to PIN entry after inactivity

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

---

## 📋 How to Start a New Chat

Paste this at the top of your first message:

> "I'm continuing development on PanoramaTrack. Please read CURRENT_STATE.md and the project files to get up to speed. Here's what I need help with today: [your task]"

---

_Last updated: May 14, 2026_
