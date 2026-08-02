import { createClient } from '@/lib/supabase/server'
import { isStaff } from '@/types/database'
import {
  timeclockDb,
  type BreakType,
  type TimeEntry,
  type TimeEntryBreak,
} from '@/types/timetracking'
import { TimeClock, type TimeClockLocation } from './TimeClock'

/**
 * Reads the caller's own clock state and renders the control.
 *
 * Self-contained on purpose: drop `<TimeClockPanel compact />` into the
 * dashboard header and the clock is one tap from every staff page, with no
 * props to thread through. Renders nothing for a client or a signed-out
 * visitor, so it is safe anywhere in the staff tree.
 *
 * Every read here goes through the caller's own client, so RLS scopes it to
 * their own shift without this component having to remember to.
 */
export async function TimeClockPanel({ compact = false }: { compact?: boolean }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || profile.suspended_at || !isStaff(profile.role)) return null

  const db = timeclockDb(supabase)

  const { data: openEntry } = await db
    .from('time_entries')
    .select(
      'id, staff_id, location_id, clock_out_location_id, clocked_in_at, clocked_out_at, source, note, created_at, updated_at'
    )
    .eq('staff_id', user.id)
    .is('clocked_out_at', null)
    .maybeSingle()

  const entry = (openEntry ?? null) as TimeEntry | null

  const { data: locationRows } = await db
    .from('locations')
    .select('id, name')
    .eq('is_active', true)
    .order('sort_order')
    .order('id')

  const locations = (locationRows ?? []) as TimeClockLocation[]

  // The breaks on offer belong to wherever they are working — or, if they are
  // not on the clock yet, wherever they are about to.
  const relevantLocation = entry?.location_id ?? locations[0]?.id ?? null

  const [{ data: breakRows }, { data: openBreakRow }] = await Promise.all([
    relevantLocation === null
      ? Promise.resolve({ data: [] })
      : db
          .from('break_types')
          .select(
            'id, location_id, name, is_paid, default_minutes, description, sort_order, is_active, created_at, updated_at'
          )
          .eq('location_id', relevantLocation)
          .eq('is_active', true)
          .order('sort_order'),
    entry
      ? db
          .from('time_entry_breaks')
          .select(
            'id, time_entry_id, break_type_id, started_at, ended_at, is_paid_snapshot, name_snapshot, created_at, updated_at'
          )
          .eq('time_entry_id', entry.id)
          .is('ended_at', null)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  return (
    <TimeClock
      initial={{
        entry,
        openBreak: (openBreakRow ?? null) as TimeEntryBreak | null,
      }}
      breakTypes={(breakRows ?? []) as BreakType[]}
      locations={locations}
      compact={compact}
    />
  )
}
