-- PanoramaTrack v48.0 — Scheduled-start selection
-- Run this once in the Supabase SQL editor before deploying the v48.0 app.js/index.html.

-- New column on punches: stores the employee's confirmed actual start time (from the
-- "What time are you starting work?" popup), when they clock in before the standard start.
-- Nullable — most punches (clocking in at/after the standard start) will never set this.
-- The raw clock_in column is never modified by this feature; this is purely additive.
ALTER TABLE punches ADD COLUMN IF NOT EXISTS declared_start_time timestamptz;

-- New pt_settings columns for the scheduled-start rule (mirrors the existing sched_end_* pattern).
ALTER TABLE pt_settings ADD COLUMN IF NOT EXISTS sched_start_enabled boolean DEFAULT false;
ALTER TABLE pt_settings ADD COLUMN IF NOT EXISTS sched_start_time text DEFAULT '07:00';
ALTER TABLE pt_settings ADD COLUMN IF NOT EXISTS sched_start_early1 text DEFAULT '06:30';
ALTER TABLE pt_settings ADD COLUMN IF NOT EXISTS sched_start_early2 text DEFAULT '06:00';
ALTER TABLE pt_settings ADD COLUMN IF NOT EXISTS sched_start_grace integer DEFAULT 5;

-- Nothing to backfill — existing rows simply get the defaults above, and the feature stays off
-- (sched_start_enabled = false) until turned on in Settings, same as sched_end was when it shipped.
