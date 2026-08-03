import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { StaffBookingForm } from '@/components/shared/StaffBookingForm'
import { dayLabelForDateKey } from '@/lib/time'
import { isFrontDesk } from '@/types/database'

export const dynamic = 'force-dynamic'

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * A bare 'HH:MM' read back the way a person says it. Not a zone conversion —
 * a wall clock carries no offset — so this stays out of time.ts, the same way
 * SiteFooter's opening hours do.
 */
function wallClockLabel(time: string): string {
  const [h, m] = time.split(':').map(Number)
  const suffix = h >= 12 ? 'pm' : 'am'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${hour12}${suffix}` : `${hour12}:${String(m).padStart(2, '0')}${suffix}`
}

interface Props {
  // `date` and `time` arrive from a tap on an empty slot in the diary —
  // a date key and 'HH:MM' wall clock, both in the studio's zone.
  searchParams: Promise<{ client?: string; date?: string; time?: string }>
}

export default async function StaffBookingPage({ searchParams }: Props) {
  const { client: clientId, date, time } = await searchParams
  const supabase = await createClient()

  // Check authentication and authorization
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  // Only front desk and above can book for clients
  if (!profile || !isFrontDesk(profile.role)) {
    redirect('/dashboard')
  }

  // Shape-checked here so a hand-edited query string can never reach the form
  // as a selection. A time without a date is meaningless, so it needs both.
  const preselectedDate = date && DATE_KEY_RE.test(date) ? date : undefined
  const preselectedTime =
    preselectedDate && time && TIME_RE.test(time) ? time : undefined

  // Fetch active services and providers
  const [
    { data: services },
    { data: providers },
    { data: selectedClient },
  ] = await Promise.all([
    supabase
      .from('services')
      .select('id, name, slug, price_cents, duration_minutes, requires_age_verification, requires_consultation')
      .eq('is_active', true)
      .order('sort_order'),
    supabase
      .from('profiles')
      .select('id, first_name, last_name, timezone')
      // Bookable is `accepts_online_booking`, not role — a solo owner is
      // admin AND the person doing the treatment. See migration 020.
      .neq('role', 'client')
      .eq('accepts_online_booking', true)
      .is('suspended_at', null)
      .order('first_name'),
    clientId
      ? supabase
          .from('profiles')
          .select('id, first_name, last_name, email, phone')
          .eq('id', clientId)
          .eq('role', 'client')
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  return (
    <div>
      <h1 className="display text-3xl">Book Appointment for Client</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        Staff booking — use this to book appointments on behalf of clients
      </p>

      {/* Say out loud what the diary handed over. The date and time apply the
          moment step 3 opens, but step 3 is hidden until a client, a service
          and a provider are chosen — so without this the tap on an empty slot
          looks like it was thrown away, and the person re-picks the day they
          already picked. */}
      {preselectedDate && (
        <p className="mt-6 max-w-3xl border-l-2 border-[var(--color-accent)] bg-[var(--color-surface)] px-4 py-3 text-sm">
          <span className="label-caps mr-2 text-[var(--color-muted)]">From the diary</span>
          {dayLabelForDateKey(preselectedDate)}
          {preselectedTime && ` at ${wallClockLabel(preselectedTime)}`}
          <span className="mt-1 block text-[var(--color-muted)]">
            {preselectedTime
              ? // Honest about the one case that does not resolve: the diary grid
                // is hourly, availability follows the provider's own interval, so
                // a tapped hour is not always a slot start.
                'The day is already set. Pick the client, service and provider, and step 3 opens on this time if it is one the provider offers — otherwise choose from the times it lists.'
              : 'The day is already set. Pick the client, service and provider, and choose a time in step 3.'}
          </span>
        </p>
      )}

      <div className="mt-8 max-w-3xl">
        <StaffBookingForm
          services={services ?? []}
          providers={providers ?? []}
          preselectedClient={selectedClient ?? undefined}
          preselectedDate={preselectedDate}
          preselectedTime={preselectedTime}
        />
      </div>
    </div>
  )
}
