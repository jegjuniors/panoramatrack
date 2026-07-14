-- PanoramaTrack — Submission notification settings
-- Run this once in the Supabase SQL editor before deploying this build.
--
-- Two new pt_settings columns backing the "email the office when a supervisor submits
-- timecards" feature. submit_notify_emails is stored as a cleaned, comma-separated string
-- (parsed/validated client-side in the Settings screen before saving).
ALTER TABLE pt_settings ADD COLUMN IF NOT EXISTS submit_notify_enabled boolean DEFAULT false;
ALTER TABLE pt_settings ADD COLUMN IF NOT EXISTS submit_notify_emails text DEFAULT '';
