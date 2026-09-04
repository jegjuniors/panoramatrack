-- PanoramaTrack v49.7 — Employee-provided estimated clock-out
-- Run this once in the Supabase SQL editor before deploying the v49.7 app.js/index.html.

-- New column on punches: stores the employee's own rough estimate of when they'll clock out,
-- collected when they submit their timecard while a punch is still open (no clock_out yet).
-- Purely a note for supervisors/admins reviewing an open punch — the raw clock_in/clock_out
-- columns are never touched by this feature; it's cleared back to null whenever the punch gets
-- a real clock-out (normal clock-out, 12-hour auto-clock, or a manual edit that sets one).
ALTER TABLE punches ADD COLUMN IF NOT EXISTS estimated_clock_out timestamptz;

-- Nothing to backfill — existing open punches simply have no estimate until an employee
-- submits their timecard while that punch is still open.
