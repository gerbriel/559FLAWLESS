import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CalendarClient } from '@/components/shared/CalendarClient'
import { addDaysToDateKey, dateKeyInTimeZone, zonedTimeToUtc } from '@/lib/time'
import { isFrontDesk, type UserRole } from '@/types/database'
import type { CalendarView } from '@/components/shared/CalendarView'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'

interface Props {
  searchParams: Promise<{ from?: string; view?: string }>
}

export default async function CalendarPage({ searchParams }: Props) {
  const { from, view: viewParam } = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, timezone')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'provider') as UserRole
  const tz = profile?.timezone || STUDIO_TZ

  const todayKey = dateKeyInTimeZone(new Date(), tz)
  const startKey = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from! : todayKey
  
  // Determine view and date range
  const view = (viewParam === 'day' || viewParam === 'week' || viewParam === 'month') 
    ? viewParam as CalendarView 
    : 'week'

  // Calculate date range based on view
  let endKey: string
  if (view === 'day') {
    endKey = addDaysToDateKey(startKey, 1)
  } else if (view === 'week') {
    endKey = addDaysToDateKey(startKey, 7)
  } else {
    // Month view - fetch entire month plus a week on each side
    const [year, month] = startKey.split('-').map(Number)
    const firstDay = `${year}-${String(month).padStart(2, '0')}-01`
    const nextMonth = month === 12 ? 1 : month + 1
    const nextYear = month === 12 ? year + 1 : year
    const lastDay = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
    
    endKey = addDaysToDateKey(lastDay, 7)
  }

  // Fetch appointments for the calculated range
  let appointmentsQuery = supabase
    .from('appointments')
    .select(
      'id, starts_at, ends_at, status, total_cents, deposit_cents, provider_id, client_id, client_notes, staff_notes, guest_first_name, guest_last_name, guest_email, guest_phone, client:profiles!appointments_client_id_fkey(first_name, last_name, email, phone), provider:profiles!appointments_provider_id_fkey(first_name, last_name, display_name), appointment_services(name_snapshot, price_cents, duration_minutes, sort_order)'
    )
    .gte('starts_at', zonedTimeToUtc(startKey, '00:00', tz).toISOString())
    .lt('starts_at', zonedTimeToUtc(endKey, '00:00', tz).toISOString())
    .neq('status', 'cancelled')
    .order('starts_at')

  // Providers see their own appointments only
  if (!isFrontDesk(role)) {
    appointmentsQuery = appointmentsQuery.eq('provider_id', user.id)
  }

  const { data: appointments } = await appointmentsQuery

  // Fetch all active providers for filtering
  const { data: providers } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, display_name')
    .in('role', ['provider', 'front_desk', 'manager', 'admin'])
    .is('suspended_at', null)
    .order('display_name')

  // Format appointments data for the client component
  const formattedAppointments = (appointments || []).map(appt => ({
    ...appt,
    profiles: appt.client || null,
    provider: appt.provider || null,
  })) as any

  return (
    <div>
      <h1 className="display mb-10 text-3xl">Calendar</h1>
      
      <CalendarClient
        initialAppointments={formattedAppointments}
        providers={(providers || []) as any}
        timezone={tz}
        initialDate={startKey}
        initialView={view}
      />
    </div>
  )
}
