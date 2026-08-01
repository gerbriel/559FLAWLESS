import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Input } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import { formatMoney, initials } from '@/lib/utils'
import { AlertTriangle, CheckCircle2, ShoppingCart } from 'lucide-react'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ q?: string }>
}

export default async function ClientsPage({ searchParams }: Props) {
  const { q } = await searchParams
  const supabase = await createClient()

  let query = supabase
    .from('profiles')
    .select(
      'id, first_name, last_name, email, phone, created_at, client_records(visit_count, last_visit_at, no_show_count, lifetime_value_cents)'
    )
    .eq('role', 'client')
    .order('created_at', { ascending: false })
    .limit(100)

  if (q?.trim()) {
    const term = `%${q.trim()}%`
    query = query.or(
      `first_name.ilike.${term},last_name.ilike.${term},email.ilike.${term},phone.ilike.${term}`
    )
  }

  const { data: clients } = await query

  // Fetch form statuses and analytics for all clients
  const clientIds = clients?.map(c => c.id) ?? []
  
  const [
    { data: consents },
    { data: intakes },
    { data: analytics },
  ] = await Promise.all([
    supabase
      .from('consent_signatures')
      .select('client_id, expires_at')
      .in('client_id', clientIds),
    supabase
      .from('intake_submissions')
      .select('client_id, flags, reviewed_at')
      .in('client_id', clientIds),
    supabase
      .from('analytics_events')
      .select('user_id, event')
      .in('user_id', clientIds),
  ])

  // Build status maps
  const now = new Date()
  const expiredConsentsMap = new Map<string, number>()
  consents?.forEach(c => {
    if (c.expires_at && new Date(c.expires_at) < now) {
      expiredConsentsMap.set(c.client_id, (expiredConsentsMap.get(c.client_id) ?? 0) + 1)
    }
  })

  const flaggedIntakesMap = new Map<string, number>()
  intakes?.forEach(i => {
    if (i.flags && i.flags.length > 0 && !i.reviewed_at) {
      flaggedIntakesMap.set(i.client_id, (flaggedIntakesMap.get(i.client_id) ?? 0) + 1)
    }
  })

  const bookingAbandonedMap = new Map<string, number>()
  analytics?.forEach(e => {
    if (e.event === 'booking_started' || e.event === 'booking_abandoned') {
      const current = bookingAbandonedMap.get(e.user_id!) ?? 0
      bookingAbandonedMap.set(e.user_id!, current + (e.event === 'booking_started' ? 1 : -1))
    }
  })

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Clients</h1>
        <span className="text-sm text-[var(--color-muted)]">
          {clients?.length ?? 0} shown
        </span>
      </div>

      <form className="mt-8 max-w-md">
        <Input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search by name, email, or phone"
          aria-label="Search clients"
        />
      </form>

      {(clients?.length ?? 0) === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          {q ? 'No clients matched that search.' : 'No clients yet.'}
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {(clients ?? []).map((c) => {
            const record = c.client_records as unknown as {
              visit_count: number
              last_visit_at: string | null
              no_show_count: number
              lifetime_value_cents: number
            } | null

            const expiredConsents = expiredConsentsMap.get(c.id) ?? 0
            const flaggedIntakes = flaggedIntakesMap.get(c.id) ?? 0
            const abandonedBookings = bookingAbandonedMap.get(c.id) ?? 0

            return (
              <li key={c.id}>
                <Link
                  href={`/dashboard/clients/${c.id}`}
                  className="flex flex-wrap items-center gap-x-6 gap-y-3 py-5 transition-colors hover:text-[var(--color-accent)]"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-[var(--color-border)] text-xs">
                    {initials(c.first_name, c.last_name)}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p>
                      {c.first_name} {c.last_name}
                    </p>
                    <p className="mt-0.5 truncate text-sm text-[var(--color-muted)]">
                      {c.email}
                      {c.phone && ` · ${c.phone}`}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {expiredConsents > 0 && (
                        <Badge tone="warning">
                          <AlertTriangle className="mr-1 h-3 w-3" />
                          {expiredConsents} consent expired
                        </Badge>
                      )}
                      {flaggedIntakes > 0 && (
                        <Badge tone="danger">
                          <AlertTriangle className="mr-1 h-3 w-3" />
                          {flaggedIntakes} intake flag{flaggedIntakes > 1 ? 's' : ''}
                        </Badge>
                      )}
                      {abandonedBookings > 0 && (
                        <Badge tone="info">
                          <ShoppingCart className="mr-1 h-3 w-3" />
                          {abandonedBookings} abandoned
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-sm">
                    {(record?.no_show_count ?? 0) > 0 && (
                      <Badge tone="danger">{record!.no_show_count} no-show</Badge>
                    )}
                    <span className="text-[var(--color-muted)]">
                      {record?.visit_count ?? 0} visits
                    </span>
                    <span className="w-20 text-right tabular-nums">
                      {formatMoney(record?.lifetime_value_cents ?? 0)}
                    </span>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
