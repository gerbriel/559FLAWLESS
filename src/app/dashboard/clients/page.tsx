import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ButtonLink } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Avatar,
  EmptyState,
  PageHeader,
  Pagination,
  Panel,
  SearchField,
} from '@/components/ui/dashboard'
import { NewClientForm } from '@/components/shared/NewClientForm'
import { SectionTabs } from '@/components/layout/SectionTabs'
import { formatMoney } from '@/lib/utils'
import { isFrontDesk, type UserRole } from '@/types/database'
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarPlus,
  CheckCircle2,
  SearchX,
  ShoppingCart,
  Users,
} from 'lucide-react'

export const dynamic = 'force-dynamic'

/**
 * How many people a page of the roster holds. Small enough that the whole
 * page is one screen's worth of scrolling, and it also bounds the four
 * follow-up queries below — they look up form status only for the rows
 * actually on screen.
 */
const PAGE_SIZE = 25

/**
 * One grid template, shared by the header row and every row under it, so the
 * columns line up without either one knowing about the other. Below `sm` the
 * grid collapses to a single column and each row stacks — a phone scrolls
 * down, never sideways.
 */
const COLUMNS =
  'sm:grid-cols-[minmax(0,1.7fr)_minmax(0,1.7fr)_minmax(0,1fr)_auto_2.75rem]'

/** The small circle at the end of a row. Full 44px until there is a mouse. */
const ROW_ACTION =
  'flex h-11 w-11 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-foreground)] sm:h-9 sm:w-9'

interface Props {
  searchParams: Promise<{ q?: string; page?: string }>
}

export default async function ClientsPage({ searchParams }: Props) {
  const { q, page: pageParam } = await searchParams
  const supabase = await createClient()

  const term = q?.trim() ?? ''
  const page = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

  // Paging lives in the URL so a refresh lands where you were and a link can be
  // handed to someone else. The search comes along for the ride; page 1 is the
  // bare URL rather than `?page=1`.
  function hrefFor(n: number): string {
    const params = new URLSearchParams()
    if (term) params.set('q', term)
    if (n > 1) params.set('page', String(n))
    const query = params.toString()
    return query ? `/dashboard/clients?${query}` : '/dashboard/clients'
  }

  let query = supabase
    .from('profiles')
    // The FK must be named. `client_records` points at `profiles` twice —
    // `client_id` and `preferred_provider_id` — so a bare `client_records(...)`
    // embed is ambiguous. PostgREST answers that with an error rather than
    // rows, which silently rendered this page as "no clients" even when
    // clients existed.
    .select(
      'id, first_name, last_name, email, phone, created_at, client_records!client_records_client_id_fkey(visit_count, last_visit_at, no_show_count, lifetime_value_cents)',
      // The count is what tells the pager how many pages there are, and it is
      // counted under the same filters and the same RLS as the rows.
      { count: 'exact' }
    )
    .eq('role', 'client')
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)

  if (term) {
    const pattern = `%${term}%`
    query = query.or(
      `first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern}`
    )
  }

  // The roster itself needs nothing from the session, so the session read rides
  // alongside it rather than costing a round trip of its own.
  const [
    {
      data: { user },
    },
    { data: clients, count },
  ] = await Promise.all([supabase.auth.getUser(), query])

  if (!user) redirect('/login?next=/dashboard/clients')

  const total = count ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // A hand-typed `?page=99` on a list of forty would otherwise render as "no
  // clients", which reads as an empty CRM rather than as a page past the end.
  if (page > pageCount && total > 0) redirect(hrefFor(pageCount))

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

  const shown = clients?.length ?? 0
  const lede =
    total === 0
      ? undefined
      : term
        ? `${total} ${total === 1 ? 'match' : 'matches'} for “${term}”.`
        : pageCount > 1
          ? `${total} clients, newest first — showing ${offset + 1}–${offset + shown}.`
          : `${total} ${total === 1 ? 'client' : 'clients'}, newest first.`

  return (
    <div>
      <PageHeader
        title="Clients"
        lede={lede}
        actions={
          // Both doors are front-desk-only: /api/admin/clients/create answers
          // 403 below front desk, and book-for-client redirects. Offering
          // either to a provider is a control that can only fail on use.
          booksForOthers && (
            <>
              <ButtonLink
                href="/dashboard/appointments/book-for-client"
                variant="subtle"
                size="sm"
              >
                <CalendarPlus className="h-4 w-4" strokeWidth={1.75} />
                Book appointment
              </ButtonLink>
              <NewClientForm />
            </>
          )
        }
      />

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

      {/* A GET form, so the search is in the URL like everything else here.
          `page` is deliberately not a field: a new search starts at the top of
          its own results rather than on whatever page you happened to be on. */}
      <form role="search" className="mt-6 max-w-xl">
        <SearchField name="q" defaultValue={q ?? ''} label="Search by name, email, or phone" />
      </form>

      {total === 0 ? (
        term ? (
          <EmptyState
            className="mt-8"
            icon={SearchX}
            title="Nothing matched that search"
            description={`No name, email address or phone number on the list contains “${term}”.`}
            action={
              <ButtonLink href="/dashboard/clients" variant="subtle" size="sm">
                Show all clients
              </ButtonLink>
            }
          />
        ) : (
          <EmptyState
            className="mt-8"
            icon={Users}
            title="No clients yet"
            description={
              booksForOthers
                ? 'Anyone who books online lands here on their own. Add a walk-in or a phone booking yourself.'
                : 'The clients you treat appear here once they have an appointment with you.'
            }
            action={booksForOthers ? <NewClientForm /> : undefined}
          />
        )
      ) : (
        <>
          <Panel className="mt-8 overflow-hidden">
            {/* Column headings, for the widths that have columns. On a phone
                the rows stack and each value reads for itself, so the header
                would be a heading for nothing. */}
            <div
              aria-hidden
              className={`label-caps hidden gap-x-6 border-b border-[var(--color-border)] px-5 py-3.5 text-[var(--color-muted)] sm:grid ${COLUMNS}`}
            >
              <span>Name</span>
              <span>Email</span>
              <span>Phone</span>
              <span className="text-right">Visits &amp; value</span>
              <span />
            </div>

            <ul className="divide-y divide-[var(--color-border)]">
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

                // A record created by staff mid-call can be missing a name;
                // the email is what the person is known by until it arrives,
                // and a row with nothing to click on would strand the record.
                const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()
                const label = name || c.email || 'Unnamed client'

                return (
                  <li
                    key={c.id}
                    className={`relative grid items-center gap-x-6 gap-y-2 px-5 py-4 transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)] ${COLUMNS}`}
                  >
                    {/* The name is the link to the record. It used to be the
                        whole row, which cannot hold the quick action beside it
                        — a link inside a link is not markup a browser has an
                        opinion about worth relying on. The padding keeps a long
                        name off the action button on a phone, where that button
                        is pinned to the corner rather than stacked last. */}
                    <div className="flex min-w-0 items-center gap-3.5 pr-12 sm:pr-0">
                      <Avatar name={label} />
                      <div className="min-w-0">
                        <Link
                          href={`/dashboard/clients/${c.id}`}
                          className="block truncate transition-colors hover:text-[var(--color-accent)]"
                        >
                          {label}
                        </Link>

                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {/* Forms status, always shown — a client with nothing
                              on file is the one you most need to spot. */}
                          {!hasIntake ? (
                            <Badge tone="neutral" size="sm">No intake on file</Badge>
                          ) : intakeUnreviewed ? (
                            <Badge tone="info" size="sm">Intake awaiting review</Badge>
                          ) : (
                            <Badge tone="success" size="sm">
                              <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
                              Intake complete
                            </Badge>
                          )}
                          {!hasConsent && (
                            <Badge tone="neutral" size="sm">No consent signed</Badge>
                          )}
                          {expiredConsents > 0 && (
                            <Badge tone="warning" size="sm">
                              <AlertTriangle className="h-3 w-3" strokeWidth={2} />
                              {expiredConsents} consent expired
                            </Badge>
                          )}
                          {flaggedIntakes > 0 && (
                            <Badge tone="danger" size="sm">
                              <AlertTriangle className="h-3 w-3" strokeWidth={2} />
                              {flaggedIntakes} intake flag{flaggedIntakes > 1 ? 's' : ''}
                            </Badge>
                          )}
                          {abandonedBookings > 0 && (
                            <Badge tone="info" size="sm">
                              <ShoppingCart className="h-3 w-3" strokeWidth={2} />
                              {abandonedBookings} abandoned
                            </Badge>
                          )}
                          {/* Missed appointments sit with the other statuses
                              rather than beside the visit count, so everything
                              worth noticing about someone is in one place. */}
                          {(record?.no_show_count ?? 0) > 0 && (
                            <Badge tone="danger" size="sm">
                              {record!.no_show_count} no-show
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="min-w-0 text-sm text-[var(--color-muted)]">
                      {c.email ? (
                        <a
                          href={`mailto:${c.email}`}
                          className="block truncate transition-colors hover:text-[var(--color-foreground)]"
                        >
                          {c.email}
                        </a>
                      ) : (
                        // The dash holds an empty column open. Stacked on a
                        // phone there is no column to hold, and a lone dash
                        // under someone's name is a puzzle.
                        <span className="hidden sm:block" aria-hidden>
                          —
                        </span>
                      )}
                    </div>

                    <div className="text-sm text-[var(--color-muted)]">
                      {c.phone ? (
                        <a
                          href={`tel:${c.phone}`}
                          className="transition-colors hover:text-[var(--color-foreground)]"
                        >
                          {c.phone}
                        </a>
                      ) : (
                        <span className="hidden sm:block" aria-hidden>
                          —
                        </span>
                      )}
                    </div>

                    <div className="text-sm tabular-nums text-[var(--color-muted)] sm:text-right">
                      {record?.visit_count ?? 0} {record?.visit_count === 1 ? 'visit' : 'visits'}
                      <span className="mx-1.5" aria-hidden>·</span>
                      <span className="text-[var(--color-foreground)]">
                        {formatMoney(record?.lifetime_value_cents ?? 0)}
                      </span>
                    </div>

                    {/* The row's quick action. Booking for someone else is
                        front-desk-only — a provider gets the way into the
                        record instead, which is the thing this list is for
                        when you cannot book. */}
                    <div className="absolute right-4 top-4 sm:static sm:justify-self-end">
                      {booksForOthers ? (
                        <Link
                          href={`/dashboard/appointments/book-for-client?client=${c.id}`}
                          className={ROW_ACTION}
                        >
                          <CalendarPlus className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                          <span className="sr-only">Book an appointment for {label}</span>
                        </Link>
                      ) : (
                        <Link
                          href={`/dashboard/clients/${c.id}`}
                          className={ROW_ACTION}
                        >
                          <ArrowUpRight className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                          <span className="sr-only">Open {label}&rsquo;s record</span>
                        </Link>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </Panel>

          <Pagination page={page} pageCount={pageCount} hrefFor={hrefFor} className="mt-8" />
        </>
      )}
    </div>
  )
}
