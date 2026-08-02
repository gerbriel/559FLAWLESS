/**
 * Row shapes for time tracking (migration 035).
 *
 * These live here rather than in `src/types/database.ts` only because that file
 * is regenerated centrally. The `Tables` and `Functions` entries to add to it
 * are listed at the bottom of this file; once they land, delete `timeclockDb`
 * below and nothing else changes.
 *
 * Type aliases, never interfaces — an interface has no implicit index signature
 * and so fails supabase-js's `Record<string, unknown>` constraint, which
 * silently collapses every query result to `never`.
 */

/** How a punch got into the system. `manual` means somebody corrected it. */
export type TimeEntrySource = 'app' | 'manual' | 'import'

/** What the audit log is recording. */
export type TimeEntryEditAction = 'created' | 'corrected' | 'deleted'

export type BreakType = {
  id: number
  location_id: number
  name: string
  /**
   * The field the whole table exists for. Unpaid time is deducted from hours
   * worked; paid time is not.
   */
  is_paid: boolean
  default_minutes: number | null
  description: string | null
  sort_order: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export type TimeEntry = {
  id: number
  staff_id: string
  /** Where the shift STARTED. What it is attributed to in every report. */
  location_id: number
  /** Only set when they clocked out somewhere else. */
  clock_out_location_id: number | null
  clocked_in_at: string
  /** Null while the shift is running. */
  clocked_out_at: string | null
  source: TimeEntrySource
  note: string | null
  created_at: string
  updated_at: string
}

export type TimeEntryBreak = {
  id: number
  time_entry_id: number
  break_type_id: number
  started_at: string
  ended_at: string | null
  /**
   * Paid-ness as it was when the break was taken, not as the type reads today.
   * Editing a break type must not restate what someone was already paid.
   */
  is_paid_snapshot: boolean
  name_snapshot: string
  created_at: string
  updated_at: string
}

export type TimeEntryEdit = {
  id: number
  /** Null once the shift itself has been deleted — the log outlives it. */
  time_entry_id: number | null
  /** Whose timesheet it was. Denormalised so an orphaned row still means something. */
  staff_id: string
  edited_by: string | null
  edited_at: string
  action: TimeEntryEditAction
  reason: string | null
  before_clocked_in_at: string | null
  before_clocked_out_at: string | null
  before_location_id: number | null
  after_clocked_in_at: string | null
  after_clocked_out_at: string | null
  after_location_id: number | null
}

/** One row of `timesheet_entries()`. All minute figures are integers. */
export type TimesheetEntry = {
  entry_id: number
  staff_id: string
  staff_name: string | null
  location_id: number
  location_name: string | null
  clock_out_location_id: number | null
  clocked_in_at: string
  clocked_out_at: string | null
  is_open: boolean
  gross_minutes: number
  paid_break_minutes: number
  unpaid_break_minutes: number
  /** gross − unpaid breaks. Zero while the shift is still open. */
  worked_minutes: number
  source: TimeEntrySource
  note: string | null
  edit_count: number
  last_edited_at: string | null
  last_edited_by_name: string | null
}

/** One row of `time_clock_reminder_candidates()`. */
export type ReminderCandidate = {
  staff_id: string
  kind: 'clock_in' | 'clock_out'
  shift_start: string | null
  shift_end: string | null
  local_date: string
  timezone: string
  entry_id: number | null
}

/** What the clock needs to render itself. */
export type TimeClockState = {
  entry: TimeEntry | null
  openBreak: TimeEntryBreak | null
}

/**
 * `src/types/database.ts` does not carry the 035 tables yet (see the entries at
 * the foot of this file). Until it does, the time-clock tables and RPCs are
 * reached through this cast; results are then read as the row types above.
 *
 * Delete this function — not the types — once the entries are merged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const timeclockDb = (client: unknown): any => client

/** "7h 25m", "45m", "—". Minutes in, never seconds. */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return '—'
  if (minutes <= 0) return '0m'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * Elapsed whole minutes since an instant.
 *
 * Floored, to agree with `timeclock_whole_minutes()` in the database — a live
 * counter that rounds up would read a minute ahead of the timesheet it is
 * about to become.
 */
export function elapsedMinutesSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000))
}

/* ────────────────────────────────────────────────────────────────────────────
 * ENTRIES TO ADD TO src/types/database.ts
 *
 * Enums (near the other enums at the top):
 *
 *   export type TimeEntrySource = 'app' | 'manual' | 'import'
 *   export type TimeEntryEditAction = 'created' | 'corrected' | 'deleted'
 *
 * Row shapes: re-export or copy BreakType, TimeEntry, TimeEntryBreak,
 * TimeEntryEdit and TimesheetEntry from this file verbatim.
 *
 * Tables:
 *
 *   break_types: TableDef<
 *     BreakType,
 *     [Rel<'break_types_location_id_fkey', ['location_id'], 'locations', ['id']>]
 *   >
 *   time_entries: TableDef<
 *     TimeEntry,
 *     [
 *       ToProfile<'time_entries', 'staff_id'>,
 *       Rel<'time_entries_location_id_fkey', ['location_id'], 'locations', ['id']>,
 *       Rel<'time_entries_clock_out_location_id_fkey', ['clock_out_location_id'], 'locations', ['id']>,
 *     ]
 *   >
 *   time_entry_breaks: TableDef<
 *     TimeEntryBreak,
 *     [
 *       Rel<'time_entry_breaks_time_entry_id_fkey', ['time_entry_id'], 'time_entries', ['id']>,
 *       Rel<'time_entry_breaks_break_type_id_fkey', ['break_type_id'], 'break_types', ['id']>,
 *     ]
 *   >
 *   time_entry_edits: TableDef<
 *     TimeEntryEdit,
 *     [
 *       Rel<'time_entry_edits_time_entry_id_fkey', ['time_entry_id'], 'time_entries', ['id']>,
 *       ToProfile<'time_entry_edits', 'staff_id'>,
 *       ToProfile<'time_entry_edits', 'edited_by'>,
 *     ]
 *   >
 *
 * NOTE: time_entries has three FKs and time_entry_edits has two to `profiles`,
 * so any PostgREST embed must name the constraint:
 *   profiles!time_entries_staff_id_fkey(first_name, last_name)
 *
 * Functions:
 *
 *   clock_in:  { Args: { p_location_id?: number | null }; Returns: number }
 *   clock_out: { Args: { p_location_id?: number | null; p_note?: string | null }; Returns: number }
 *   start_break: { Args: { p_break_type_id: number }; Returns: number }
 *   end_break:   { Args: Record<PropertyKey, never>; Returns: number }
 *   correct_time_entry: {
 *     Args: {
 *       p_entry_id: number
 *       p_clocked_in: string
 *       p_clocked_out: string | null
 *       p_reason: string
 *       p_location_id?: number | null
 *     }
 *     Returns: number
 *   }
 *   timesheet_entries: {
 *     Args: { p_from: string; p_to: string; p_staff?: string | null; p_location?: number | null }
 *     Returns: TimesheetEntry[]
 *   }
 *   worked_minutes: {
 *     Args: { p_staff: string; p_from: string; p_to: string; p_location?: number | null }
 *     Returns: number
 *   }
 *   timeclock_whole_minutes: { Args: { p_from: string; p_to: string }; Returns: number }
 *   time_clock_reminder_candidates: {
 *     Args: { p_late_in_minutes?: number; p_late_out_minutes?: number; p_orphan_hours?: number }
 *     Returns: ReminderCandidate[]
 *   }
 *   send_time_clock_reminders: {
 *     Args: { p_late_in_minutes?: number; p_late_out_minutes?: number; p_orphan_hours?: number }
 *     Returns: number
 *   }
 * ──────────────────────────────────────────────────────────────────────────── */
