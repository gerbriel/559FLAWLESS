import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { StaffBookingForm } from '@/components/shared/StaffBookingForm'
import { isFrontDesk } from '@/types/database'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ client?: string }>
}

export default async function StaffBookingPage({ searchParams }: Props) {
  const { client: clientId } = await searchParams
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

      <div className="mt-8 max-w-3xl">
        <StaffBookingForm
          services={services ?? []}
          providers={providers ?? []}
          preselectedClient={selectedClient ?? undefined}
        />
      </div>
    </div>
  )
}
