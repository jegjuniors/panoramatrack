-- ============================================================
-- PanoramaTrack v37.1 — Supabase SQL
-- Run this in the Supabase SQL editor.
-- ============================================================

-- 1) PROTECTIVE TRIGGER (run this — it is the part that stops the bleeding)
--    Blocks any update that tries to auto-clock a punch which already has a
--    clock_out. Preserves the real clock-out no matter which app version a
--    phone is running. Supervisor edits set auto_clocked = false, so manual
--    corrections are unaffected.

create or replace function prevent_autoclock_overwrite()
returns trigger as $$
begin
  if NEW.auto_clocked = true and OLD.clock_out is not null then
    -- An auto-clock is landing on an already-closed punch: keep the real value.
    return OLD;
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_prevent_autoclock_overwrite on punches;

create trigger trg_prevent_autoclock_overwrite
before update on punches
for each row
execute function prevent_autoclock_overwrite();


-- 2) CLEANUP HELPER (read-only — lists the punches to fix by hand)
--    Auto-clocked punches since Jun 8. Some are genuine forgot-to-clock-out;
--    the rest are overwritten clock-outs. Supervisors can tell which is which,
--    then correct each one in the app's edit modal.

-- select id, employee_name, clock_in, clock_out, auto_clocked, manual_entry
-- from punches
-- where auto_clocked = true
--   and clock_in >= '2026-06-08'
-- order by clock_in;
