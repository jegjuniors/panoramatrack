-- PanoramaTrack v49.12 — FIX for migration_punch_updated_at.sql
-- Run this once in the Supabase SQL editor. It repairs the data — no app.js/index.html change
-- needed, nothing to redeploy.
--
-- What went wrong: migration_punch_updated_at.sql created the trg_punch_updated_at trigger
-- BEFORE running its own backfill (`UPDATE punches SET updated_at = clock_in`). Since the
-- trigger fires on every UPDATE — including that backfill statement itself — it silently
-- overrode the backfill and stamped every existing punch's updated_at as "the moment the
-- migration ran" instead of its own clock_in. Result: every already-submitted/exported
-- timecard reads as "changed" right now, which is the false-positive flood you're seeing.
--
-- Fix: disable the trigger just long enough to redo the backfill correctly, then re-enable it.
-- Everything going forward (new clock-ins/outs, edits) is unaffected either way — the trigger
-- was always working correctly for real, ongoing writes; only the one-time historical backfill
-- got clobbered.

ALTER TABLE punches DISABLE TRIGGER trg_punch_updated_at;
UPDATE punches SET updated_at = clock_in;
ALTER TABLE punches ENABLE TRIGGER trg_punch_updated_at;

-- Note: if anyone genuinely edited a punch between when you first ran the buggy migration and
-- now, this resets that punch's updated_at back to its clock_in too — so a real edit in that
-- narrow window would stop showing as "changed" until edited again. Safer direction to err in
-- than leaving the flood up, and low-risk given how soon this was caught.
