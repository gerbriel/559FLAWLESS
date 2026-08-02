import Link from 'next/link'
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
      {/* The way back, matching /dashboard/messages/[id]. This page sits under
          Messages and has no sidebar entry of its own. */}
      <Link href="/dashboard/messages" className="label-caps text-[var(--color-muted)]">
        ← Messages
      </Link>

      <h1 className="display mt-8 text-3xl">Message several clients</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
        One thread each, not a group conversation — everyone gets their own, and replies
        come back to Messages as normal.
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
