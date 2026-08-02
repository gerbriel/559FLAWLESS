import { redirect } from 'next/navigation'
import { AlertTriangle, PenLine } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'
import { TimeClockPanel } from '@/components/shared/TimeClockPanel'
import { TimeClockCorrection } from '@/components/shared/TimeClockCorrection'
import { isManager, type UserRole } from '@/types/database'
import {
  timeclockDb,
  formatMinutes,
  type TimesheetEntry,
} from '@/types/timetracking'
import {
  addDaysToDateKey,
  dateKeyInTimeZone,
  dayLabelForDateKey,
  formatTimeInTimeZone,
  requestNow,
  timeZoneAbbreviation,
  zonedTimeToUtc,
} from '@/lib/time'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{
    from?: string
    to?: string
    staff?: string
    location?: string
    remind?: string
  }>
}

/** Two weeks back is the span someone actually checks before payroll. */
const DEFAULT_SPAN_DAYS = 13

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

export default async function TimesheetsPage({ searchParams }: Props) {
  const params = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/timesheets')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, timezone, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || profile.suspended_at) redirect('/account')

  const role = profile.role as UserRole
  const canSeeEveryone = isManager(role)

  const db = timeclockDb(supabase)

  const { data: locationRows } = await db
    .from('locations')
    .select('id, name, timezone')
    .eq('is_active', true)
    .order('sort_order')
    .order('id')

  const locations = (locationRows ?? []) as { id: number; name: string; timezone: string }[]

  const locationFilter =
    params.location && /^\d+$/.test(params.location) ? Number(params.location) : null

  // The zone the day boundaries are drawn in. A location's own zone is
  // authoritative for its wall clock, so filtering to one site reads the day
  // the way that site does; with everything aggregated there is no single
  // right answer, so it falls back to the viewer's own.
  const tz =
    locations.find((l) => l.id === locationFilter)?.timezone ||
    profile.timezone ||
    locations[0]?.timezone ||
    'America/Los_Angeles'

  const todayKey = dateKeyInTimeZone(new Date(requestNow()), tz)
  const fromKey = DATE_KEY.test(params.from ?? '')
    ? params.from!
    : addDaysToDateKey(todayKey, -DEFAULT_SPAN_DAYS)
  const toKey = DATE_KEY.test(params.to ?? '') ? params.to! : todayKey

  // Inclusive of `toKey`: the range runs to midnight at the START of the next
  // day, so a shift that began at 11pm on the last day is in.
  const fromInstant = zonedTimeToUtc(fromKey, '00:00', tz)
  const toInstant = zonedTimeToUtc(addDaysToDateKey(toKey, 1), '00:00', tz)

  const staffFilter = canSeeEveryone && params.staff ? params.staff : canSeeEveryone ? null : user.id

  const { data: entryRows, error } = await db.rpc('timesheet_entries', {
    p_from: fromInstant.toISOString(),
    p_to: toInstant.toISOString(),
    p_staff: staffFilter,
    p_location: locationFilter,
  })

  const entries = (entryRows ?? []) as TimesheetEntry[]

  // The staff list for the filter. RLS already scopes the rows themselves, so
  // this only ever decides what the dropdown offers.
  const { data: staffRows } = canSeeEveryone
    ? await supabase
        .from('profiles')
        .select('id, first_name, last_name, role')
        .neq('role', 'client')
        .is('suspended_at', null)
        .order('first_name')
    : { data: null }

  const staffList = (staffRows ?? []) as {
    id: string
    first_name: string | null
    last_name: string | null
  }[]

  const totalWorked = entries.reduce((sum, e) => sum + e.worked_minutes, 0)
  const totalUnpaid = entries.reduce((sum, e) => sum + e.unpaid_break_minutes, 0)
  const totalPaidBreak = entries.reduce((sum, e) => sum + e.paid_break_minutes, 0)
  const openCount = entries.filter((e) => e.is_open).length
  const editedCount = entries.filter((e) => e.edit_count > 0).length

  // Per person, for a manager looking at everyone.
  const byPerson = new Map<string, { name: string; minutes: number; shifts: number }>()
  for (const e of entries) {
    const key = e.staff_id
    const row = byPerson.get(key) ?? { name: e.staff_name ?? 'Unknown', minutes: 0, shifts: 0 }
    row.minutes += e.worked_minutes
    row.shifts += 1
    byPerson.set(key, row)
  }

  const zoneLabel = timeZoneAbbreviation(new Date(requestNow()), tz)

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Timesheets</h1>
        <span className="label-caps text-[var(--color-muted)]">
          {canSeeEveryone ? 'Everyone' : 'Your hours'} · {zoneLabel}
        </span>
      </div>

      {params.remind === 'clock_in' && (
        <p className="mt-6 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm dark:bg-[var(--color-background)]">
          Your shift has started and you are not on the clock. Punch in below — or if you
          started earlier than this, ask a manager to correct it rather than guessing.
        </p>
      )}
      {params.remind === 'clock_out' && (
        <p className="mt-6 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm dark:bg-[var(--color-background)]">
          You are still on the clock from an earlier shift. Clock out below so your hours
          are right.
        </p>
      )}

      <div className="mt-8">
        <TimeClockPanel />
      </div>

      {/* ── Filters ── */}
      <form method="get" className="mt-10 flex flex-wrap items-end gap-4">
        <Field label="From" htmlFor="from" className="w-40">
          <Input id="from" name="from" type="date" defaultValue={fromKey} />
        </Field>
        <Field label="To" htmlFor="to" className="w-40">
          <Input id="to" name="to" type="date" defaultValue={toKey} />
        </Field>

        {canSeeEveryone && (
          <Field label="Person" htmlFor="staff" className="w-52">
            <Select id="staff" name="staff" defaultValue={params.staff ?? ''}>
              <option value="">Everyone</option>
              {staffList.map((s) => (
                <option key={s.id} value={s.id}>
                  {[s.first_name, s.last_name].filter(Boolean).join(' ') || 'Unnamed'}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {locations.length > 1 && (
          <Field label="Location" htmlFor="location" className="w-48">
            <Select id="location" name="location" defaultValue={params.location ?? ''}>
              <option value="">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Button type="submit" size="sm" variant="subtle">
          Apply
        </Button>
      </form>

      {/* ── Totals ── */}
      <div className="mt-8 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-4">
        {[
          { label: 'Worked', value: formatMinutes(totalWorked) },
          { label: 'Shifts', value: String(entries.length) },
          { label: 'Unpaid breaks', value: formatMinutes(totalUnpaid) },
          { label: 'Paid breaks', value: formatMinutes(totalPaidBreak) },
        ].map((stat) => (
          <div key={stat.label} className="bg-[var(--color-surface)] px-5 py-4">
            <p className="label-caps text-[var(--color-muted)]">{stat.label}</p>
            <p className="mt-1.5 text-2xl tabular-nums">{stat.value}</p>
          </div>
        ))}
      </div>

      <p className="mt-3 text-xs text-[var(--color-muted)]">
        Minutes on the clock less unpaid breaks. Paid break time is hours worked and stays
        in. Overtime, meal-period premiums and the seventh-day rule are not computed here —
        export this and let payroll apply them.
      </p>

      {(openCount > 0 || editedCount > 0) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {openCount > 0 && (
            <Badge tone="warning">
              <AlertTriangle className="h-3 w-3" strokeWidth={2} />
              {openCount} still open
            </Badge>
          )}
          {editedCount > 0 && (
            <Badge tone="info">
              <PenLine className="h-3 w-3" strokeWidth={2} />
              {editedCount} corrected
            </Badge>
          )}
        </div>
      )}

      {/* ── Per person ── */}
      {canSeeEveryone && byPerson.size > 1 && (
        <div className="mt-10">
          <p className="label-caps text-[var(--color-muted)]">By person</p>
          <div className="mt-4 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-3">
            {[...byPerson.entries()]
              .sort((a, b) => b[1].minutes - a[1].minutes)
              .map(([id, row]) => (
                <div key={id} className="bg-[var(--color-surface)] px-5 py-4">
                  <p className="text-sm">{row.name}</p>
                  <p className="mt-1 text-xl tabular-nums">{formatMinutes(row.minutes)}</p>
                  <p className="text-xs text-[var(--color-muted)]">
                    {row.shifts} shift{row.shifts === 1 ? '' : 's'}
                  </p>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* ── The shifts ── */}
      {error ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          Could not read the timesheet.
        </p>
      ) : entries.length === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          No shifts between {dayLabelForDateKey(fromKey)} and {dayLabelForDateKey(toKey)}.
        </p>
      ) : (
        <div className="mt-10 overflow-x-auto">
          <table className="w-full min-w-4xl text-sm">
            <thead>
              <tr className="border-y border-[var(--color-border)]">
                <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">Day</th>
                {canSeeEveryone && (
                  <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">
                    Person
                  </th>
                )}
                <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">In</th>
                <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">Out</th>
                <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
                  Breaks
                </th>
                <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
                  Worked
                </th>
                {canSeeEveryone && (
                  <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
                    <span className="sr-only">Correct</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const inAt = new Date(e.clocked_in_at)
                const outAt = e.clocked_out_at ? new Date(e.clocked_out_at) : null
                const movedSite =
                  e.clock_out_location_id !== null &&
                  e.clock_out_location_id !== e.location_id
                const outSite = locations.find((l) => l.id === e.clock_out_location_id)

                return (
                  <tr key={e.entry_id} className="border-b border-[var(--color-border)] align-top">
                    <td className="px-3 py-3 whitespace-nowrap">
                      {dayLabelForDateKey(dateKeyInTimeZone(inAt, tz))}
                      {locations.length > 1 && (
                        <span className="block text-xs text-[var(--color-muted)]">
                          {e.location_name ?? '—'}
                        </span>
                      )}
                    </td>

                    {canSeeEveryone && (
                      <td className="px-3 py-3">{e.staff_name ?? 'Unknown'}</td>
                    )}

                    <td className="px-3 py-3 whitespace-nowrap tabular-nums">
                      {formatTimeInTimeZone(inAt, tz)}
                    </td>

                    <td className="px-3 py-3 whitespace-nowrap tabular-nums">
                      {outAt ? (
                        <>
                          {formatTimeInTimeZone(outAt, tz)}
                          {movedSite && (
                            <span className="block text-xs text-[var(--color-muted)]">
                              at {outSite?.name ?? 'another location'}
                            </span>
                          )}
                        </>
                      ) : (
                        <Badge tone="warning">On the clock</Badge>
                      )}
                    </td>

                    <td className="px-3 py-3 text-right tabular-nums text-[var(--color-muted)]">
                      {e.unpaid_break_minutes === 0 && e.paid_break_minutes === 0 ? (
                        '—'
                      ) : (
                        <>
                          {e.unpaid_break_minutes > 0 && (
                            <span className="block">
                              −{formatMinutes(e.unpaid_break_minutes)} unpaid
                            </span>
                          )}
                          {e.paid_break_minutes > 0 && (
                            <span className="block text-xs">
                              {formatMinutes(e.paid_break_minutes)} paid
                            </span>
                          )}
                        </>
                      )}
                    </td>

                    <td className="px-3 py-3 text-right tabular-nums">
                      {e.is_open ? (
                        <span className="text-[var(--color-muted)]">—</span>
                      ) : (
                        formatMinutes(e.worked_minutes)
                      )}
                      {e.edit_count > 0 && (
                        <span className="block text-xs text-[var(--color-muted)]">
                          corrected by {e.last_edited_by_name ?? 'someone'}
                        </span>
                      )}
                    </td>

                    {canSeeEveryone && (
                      <td className="w-80 px-3 py-3 text-right">
                        <TimeClockCorrection
                          entry={e}
                          timeZone={tz}
                          locations={locations.map((l) => ({ id: l.id, name: l.name }))}
                        />
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
