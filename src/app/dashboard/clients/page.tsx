import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Input } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import { NewClientForm } from '@/components/shared/NewClientForm'
import { SectionTabs } from '@/components/layout/SectionTabs'
import { formatMoney, initials } from '@/lib/utils'
import { isFrontDesk, type UserRole } from '@/types/database'
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
    // The FK must be named. `client_records` points at `profiles` twice —
    // `client_id` and `preferred_provider_id` — so a bare `client_records(...)`
    // embed is ambiguous. PostgREST answers that with an error rather than
    // rows, which silently rendered this page as "no clients" even when
    // clients existed.
    .select(
      'id, first_name, last_name, email, phone, created_at, client_records!client_records_client_id_fkey(visit_count, last_visit_at, no_show_count, lifetime_value_cents)'
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

  // The roster itself needs nothing from the session, so the session read rides
  // alongside it rather than costing a round trip of its own.
  const [
    {
      data: { user },
    },
    { data: clients },
  ] = await Promise.all([supabase.auth.getUser(), query])

  if (!user) redirect('/login?next=/dashboard/clients')

  // Fetch form statuses and analytics for all clients
  const clientIds = clients?.map(c => c.id) ?? []

  const [
    { data: viewer },
    { data: consents },
    { data: intakes },
    { data: analytics },
  ] = await Promise.all([
    // A provider reaches this page — the sidebar offers Clients to her, and RLS
    // gives her the people she treats. What she cannot do is anything that goes
    // through front-desk-only doors, so the role decides which of those to
    // offer. Least privilege on a missing profile, as everywhere else.
    supabase.from('profiles').select('role').eq('id', user.id).maybeSingle(),
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

  const role = (viewer?.role ?? 'provider') as UserRole
  const booksForOthers = isFrontDesk(role)

  // Build status maps
  const now = new Date()
  const expiredConsentsMap = new Map<string, number>()
  consents?.forEach(c => {
    if (c.expires_at && new Date(c.expires_at) < now) {
      expiredConsentsMap.set(c.client_id, (expiredConsentsMap.get(c.client_id) ?? 0) + 1)
    }
  })

  const flaggedIntakesMap = new Map<string, number>()
  // Presence, not just problems. A submitted intake with no flags is the
  // normal case and previously rendered nothing at all, which is
  // indistinguishable from "never filled anything in".
  const hasIntakeSet = new Set<string>()
  const intakeNeedsReviewSet = new Set<string>()
  intakes?.forEach(i => {
    hasIntakeSet.add(i.client_id)
    if (i.flags && i.flags.length > 0) {
      if (!i.reviewed_at) {
        flaggedIntakesMap.set(i.client_id, (flaggedIntakesMap.get(i.client_id) ?? 0) + 1)
      }
    } else if (!i.reviewed_at) {
      intakeNeedsReviewSet.add(i.client_id)
    }
  })

  const hasConsentSet = new Set<string>()
  consents?.forEach(c => hasConsentSet.add(c.client_id))

  const bookingAbandonedMap = new Map<string, number>()
  analytics?.forEach(e => {
    if (e.event === 'booking_started' || e.event === 'booking_abandoned') {
      const current = bookingAbandonedMap.get(e.user_id!) ?? 0
      bookingAbandonedMap.set(e.user_id!, current + (e.event === 'booking_started' ? 1 : -1))
    }
  })

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-baseline gap-4">
          <h1 className="display text-3xl">Clients</h1>
          <span className="text-sm text-[var(--color-muted)]">
            {clients?.length ?? 0} shown
          </span>
        </div>
        {/* Creating an account for a walk-in goes through
            /api/admin/clients/create, which answers 403 to anyone below front
            desk. Offering the form to a provider was a form that could only
            fail on submit. */}
        {booksForOthers && <NewClientForm />}
      </div>

      {/* View switcher — clients and newsletter signups are the same audience
          seen two ways, so they live side by side rather than in separate
          sections of the dashboard.

          Newsletter is front-desk work: /dashboard/clients/newsletter redirects
          a provider to /dashboard. With the tab hidden, one tab is left and
          SectionTabs renders nothing — for a provider, Clients is just the
          list. */}
      <SectionTabs
        label="View"
        root="/dashboard/clients"
        tabs={[
          { href: '/dashboard/clients', label: 'Clients' },
          {
            href: '/dashboard/clients/newsletter',
            label: 'Newsletter',
            visible: booksForOthers,
          },
        ]}
      />

      <form className="mt-6 max-w-md">
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
            const hasIntake = hasIntakeSet.has(c.id)
            const intakeUnreviewed = intakeNeedsReviewSet.has(c.id)
            const hasConsent = hasConsentSet.has(c.id)

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
                      {/* Forms status, always shown — a client with nothing on
                          file is the one you most need to spot. */}
                      {!hasIntake ? (
                        <Badge tone="neutral">No intake on file</Badge>
                      ) : intakeUnreviewed ? (
                        <Badge tone="info">Intake awaiting review</Badge>
                      ) : (
                        <Badge tone="success">
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          Intake complete
                        </Badge>
                      )}
                      {!hasConsent && <Badge tone="neutral">No consent signed</Badge>}
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
