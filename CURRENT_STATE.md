# PanoramaTrack — Current State

**Current Version:** v38.5
**Last Updated:** June 17, 2026

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

`pt_settings` (added v36.1, extended v36.2) is a single config row (`id = 1`) holding app-wide pay rules: `rounding_enabled`, `rounding_minutes`, `sched_end_enabled`, `sched_end_time`, `sched_end_window`, `lunch_enabled`, `lunch_minutes`, `lunch_threshold_hours`. Loaded on boot into `APP_SETTINGS`; edited in the master admin Settings tab. Rules are display/export-only — punch rows are never modified.

`punches` columns of note: `employee_id`, `employee_name`, `department`, `jobsite`, `clock_in`, `clock_out`, `activities` (array), `auto_clocked`, `edited_after_auto`, `manual_entry` (bool, added v37.0 — true for punches created via the manual Add-punch flow rather than a real clock-in; surfaces an amber "✎ Manual" badge in the logs).

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
- **Configurable pay rules (master admin Settings tab, v36.1 + v36.2)** — three admin-toggleable rules, all Supabase-backed (shared across devices) and display/export-only (raw punches untouched):
  - **Punch-time rounding** — rounds each clock-in/out to nearest 15 / 6 / 5 min (neutral nearest-mark / 7-8 rule). Default 15 min, off by default.
  - **Paid break-in-lieu credit** — clock-outs within a window (default 15 min) before a scheduled end (default 3:30 PM) are paid to the scheduled end; later punch-outs are never clipped. Off by default.
  - **Unpaid lunch deduction (v36.2)** — subtracts an unpaid lunch (default 30 min) from any shift longer than a threshold (default 5h, deduction applies to shifts *over* the threshold). Off by default. Applied as the final step after credit-then-round. With it enabled, a 7:00–3:30 day now reads **8.0h** (8.5h elapsed − 0.5h lunch). Auto-clocked and estimated punches are left exact, same as the other two rules.
  - Order: credit → round → lunch. Auto-clocked and estimated punches are always left exact. On-screen review tables show RAW times with PAID hours; PDF/CSV exports show ADJUSTED times + paid hours.
- **Manual punch entry (v37.0)** — "+ Add punch" button in both the supervisor and master logs, for an employee who forgot to clock in/out entirely. Reuses the edit modal in an add mode (`openAddPunchModal(ctx)`): employee dropdown (full active roster, alphabetical), clock-in (required), clock-out (optional — covers in-only cases), jobsite, activities. Inserts a new `punches` row with `manual_entry = true`, shown with an amber "✎ Manual" badge in both logs. Both supervisors and master can use it; supervisor scope is the full roster (per Julio's call). NOT included this version (noted for future): overlap guard against double-booking an employee, and a manual marker in CSV/PDF exports.

---

## 🚧 What Was Last Being Worked On

**Last session date:** June 17, 2026
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

## ⏭ Next Session Agenda — Per-shift lunch waive

(Version note: originally scoped as v36.3, but v37.0 — manual punch entry — shipped in between, so the lunch arc's numbering is broken. This feature involves a new `punches` column + a clock-out UI change + an approval flow, so by the version rule it's significant → confirm a whole-number bump, likely v39.0 (v38.0 was taken by the admin nav reorg), when we start.)

Automatic lunch deduction (v36.2) is in. Remaining lunch work is the worked-through-lunch case: an employee who skips lunch and leaves early should NOT be docked the 30 min. Design direction agreed with Julio; details to settle at the start.

**Direction (agreed):**
- Capture the lunch/no-lunch choice **at clock-out**, alongside the activity selection — the employee is the one who knows whether they actually took lunch; the supervisor usually doesn't.
- **NOT pure self-serve.** Treat "worked through lunch" as a **request, not an auto-apply** — otherwise there's a standing daily incentive to tick "no lunch" for 30 min of free pay across 50–100 people, which erodes the cost-savings story and contradicts the discretionary "we allow when they ask" practice. The employee's selection flags the punch as a pending waive that surfaces in the supervisor log (like the existing needs-review flag); the supervisor confirms or rejects before it affects paid hours.

**Build notes:**
- New boolean column on `punches` — e.g. `lunch_waived` (the confirmed/applied state). Likely a second flag for the pending/requested state (e.g. `lunch_waive_requested`) so request ≠ approval. It's a per-day decision, not a permanent trait. **DB migration required (Julio runs it).**
- When a punch's waive is approved, `paidHours` skips the lunch deduction for that punch only.
- OPEN to settle: exact column design (one flag vs. request+approve pair); where the supervisor approves (edit modal checkbox vs. a dedicated review action); whether the clock-out prompt only appears for shifts long enough to be docked.

Relevant code: `paidHours` (add the per-punch waive skip), `dbRowToEntry` (map the new column[s]), `clockOut` + clock-out UI (capture the request), supervisor log + edit modal (surface + approve), Settings tab unaffected.

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
| Activity dropdown scroll fade (v38.4, chevrons v38.5) | `updateActFades()`; `#act-dropdown-list-wrap` (wraps list + fades + chevrons), `#act-fade-top`/`#act-fade-bottom`/`#act-chevron-top`/`#act-chevron-bottom` in index.html; `.act-dropdown-list-wrap`/`.act-dropdown-fade*`/`.act-dropdown-chevron*` in styles.css |
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
| Edit punch (existing) | `openEditModal(ref)` / `saveEdit()` / `confirmDeletePunch()` / `deletePunch()`; `#edit-modal-bg` in index.html |
| Manual add punch (v37.0) | `openAddPunchModal(ctx)` + add branch at top of `saveEdit()`; shared edit modal in add mode (`addingPunch` / `addPunchCtx` globals); "+ Add punch" buttons in `#spanel-log` & `#mpanel-log`; `manual_entry` column; amber "✎ Manual" badge in `refreshSupLog`/`refreshMasterLog` |
| Master grouped nav (v38.0) | `switchMasterGroup(group)` / `switchMasterTab(tab)` (rewritten) / `MASTER_TAB_GROUP` + `MASTER_GROUP_DEFAULT`; top tabs `#mtab-overview/manage/reporting/settings`, sub-rows `#msub-manage` / `#msub-reporting` holding `.subnav-btn.msub-btn[data-tab]` in index.html; `.subnav-bar` / `.subnav-btn` in styles.css |
| Pay rules engine | `APP_SETTINGS` (global) / `applySettingsRow()` / `roundTime()` / `applySchedEnd()` / `adjustedTimes()` / `paidHours()` (lunch deduction lives here, v36.2) — near the time helpers (`fmtDt` area) |
| Pay rules settings UI | `refreshSettingsPanel()` / `saveSettings()`; `mtab-settings` + `mpanel-settings` in index.html; `pt_settings` table in Supabase |
| Hours display sites (use paidHours) | `refreshSupLog`, `refreshMasterLog`, `updateExportPreview`, `doMasterExport` (CSV), `generatePDF` `consolidate` |
| Supervisor log filter | `refreshSupLog()` reads `#s-filter-flags` (`''` / `stillin` / `review`) |
| Version display | `index.html` line ~153 and `app.js` backup payload |

---

## 📋 How to Start a New Chat

Paste this at the top of your first message:

> "I'm continuing development on PanoramaTrack. Please read CURRENT_STATE.md and the project files to get up to speed. Here's what I need help with today: [your task]"

---

_Last updated: June 17, 2026 — v38.5_
