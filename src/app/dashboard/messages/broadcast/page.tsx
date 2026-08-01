import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { BroadcastMessageForm } from '@/components/shared/BroadcastMessageForm'
import { isFrontDesk } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function BroadcastMessagesPage() {
  const supabase = await createClient()

  // Check authentication and authorization
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name, last_name')
    .eq('id', user.id)
    .maybeSingle()

  // Only front desk and above can send broadcasts
  if (!profile || !isFrontDesk(profile.role)) {
    redirect('/dashboard')
  }

  // Fetch all clients for selection
  const { data: clients } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, email')
    .eq('role', 'client')
    .eq('marketing_opt_in', true)
    .order('first_name')

  // Fetch analytics to identify abandoned bookings
  const { data: analyticsData } = await supabase
    .from('analytics_events')
    .select('user_id, event')
    .in('event', ['booking_started', 'booking_completed'])
    .not('user_id', 'is', null)

  // Calculate abandoned booking clients
  const abandonedMap = new Map<string, number>()
  analyticsData?.forEach(e => {
    if (e.user_id) {
      const current = abandonedMap.get(e.user_id) ?? 0
      abandonedMap.set(e.user_id, current + (e.event === 'booking_started' ? 1 : -1))
    }
  })

  const abandonedClients = clients?.filter(c => (abandonedMap.get(c.id) ?? 0) > 0) ?? []

  return (
    <div>
      <h1 className="display text-3xl">Broadcast Messages</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        Send individual message threads to multiple clients at once
      </p>

      <div className="mt-8 max-w-4xl">
        <BroadcastMessageForm
          allClients={clients ?? []}
          abandonedClients={abandonedClients}
          senderName={`${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim() || 'Staff'}
          senderId={user.id}
        />
      </div>
    </div>
  )
}
