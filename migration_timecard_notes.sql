-- PanoramaTrack v49.16 — employee notes on their timecard (one per employee per pay period).
-- Run this once in the Supabase SQL editor BEFORE deploying the v49.16 app.js/index.html.
--
-- Separate table (not a column on pt_timecard_status) because that table is one row per
-- employee per period PER JOBSITE and only exists once a card is submitted — a period-level
-- note doesn't belong on a per-site row, and employees can write a note before submitting.
--
-- period_end is stored too so the PDF exports can find every note whose pay period overlaps an
-- arbitrary report date range (period_start <= range end AND period_end >= range start).

CREATE TABLE IF NOT EXISTS pt_timecard_notes (
  id           bigint generated always as identity primary key,
  employee_id  bigint not null,
  period_start date   not null,
  period_end   date   not null,
  note         text   not null,
  updated_at   timestamptz not null default now(),
  UNIQUE (employee_id, period_start)
);

-- Match the rest of the app's tables (anon key, RLS currently disabled app-wide — see
-- HANDOFF.md "Supabase RLS is disabled" before changing this).
ALTER TABLE pt_timecard_notes DISABLE ROW LEVEL SECURITY;
