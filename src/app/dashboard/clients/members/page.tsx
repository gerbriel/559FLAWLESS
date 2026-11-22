import Link from 'next/link'
import { redirect } from 'next/navigation'
import { BadgeCheck, CalendarPlus, CheckCircle2, CreditCard, RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import {
  Avatar,
  EmptyState,
  PageHeader,
  Pagination,
  Panel,
  StatTile,
} from '@/components/ui/dashboard'
import { SectionTabs } from '@/components/layout/SectionTabs'
import { MemberRenewalToggle } from '@/components/shared/MemberRenewalToggle'
import { formatDateTimeInTimeZone, requestNow } from '@/lib/time'
import { chunked, needsFollowUp, sessionsLeftThisPeriod } from '@/lib/member-follow-up'
import { isFrontDesk, isManager, type UserRole } from '@/types/database'
import {
  MEMBERSHIP_STATUS_LABELS,
  membershipIsCurrent,
  type ClientMembership,
  type MembershipBookingIntent,
} from '@/types/memberships'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 25

/** How far back the Ended view reaches. It is a look-back, not an archive. */
const ENDED_LIMIT = 200

/**
 * One select literal for both reads below. Declared `const` so it keeps its
 * literal type: postgrest-js parses it at the type level, and a widened
 * `string` collapses the result.
 */
const MEMBER_SELECT =
  'id, client_id, membership_id, status, current_period_start, current_period_end, cancel_at_period_end, ended_at, auto_renew, stripe_subscription_id, profiles!client_memberships_client_id_fkey(first_name, last_name, email, phone), memberships!client_memberships_membership_id_fkey(name, included_sessions_per_period, period_months), membership_redemptions(sessions, redeemed_for_period_start)'

const FILTERS = ['all', 'needs_follow_up', 'payment_failed', 'renewing', 'ended'] as const
type Filter = (typeof FILTERS)[number]

const FILTER_LABELS: Record<Filter, string> = {
  all: 'All',
  needs_follow_up: 'Needs follow-up',
  payment_failed: 'Payment failed',
  renewing: 'Renewing',
  ended: 'Ended',
}

/** Same grid for the header row and every row under it. Stacks below `lg`. */
const COLUMNS =
  'lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,1fr)_auto]'

/**
 * Link pills, the same shape as the roster's: the filter lives in the URL
 * beside the page number, so a view can be refreshed or sent to someone.
 */
const PILL =
  'flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm transition-colors sm:min-h-9'
const PILL_ON =
  'border-[var(--color-foreground)] bg-[var(--color-foreground)] text-[var(--color-background)]'
const PILL_OFF =
  'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] hover:border-[var(--color-accent)]'

type MemberRow = Pick<
  ClientMembership,
  | 'id'
  | 'client_id'
  | 'membership_id'
  | 'status'
  | 'current_period_start'
  | 'current_period_end'
  | 'cancel_at_period_end'
  | 'ended_at'
  | 'auto_renew'
  | 'stripe_subscription_id'
> & {
  profiles: unknown
  memberships: unknown
  membership_redemptions: unknown
}

type Person = {
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
}
type Plan = { name: string; included_sessions_per_period: number; period_months: number }
type Spent = { sessions: number; redeemed_for_period_start: string }

interface Props {
  searchParams: Promise<{ filter?: string; page?: string }>
}

/**
 * Everyone holding a membership, and the one question the studio asks of
 * that list: who has treatments left this period and nothing booked to spend
 * them on. That is the "Needs follow-up" view, and the Today screen counts it
 * with the same rule (src/lib/member-follow-up.ts).
 *
 * Front desk and above. RLS already gives staff every membership; the gate
 * here matches the other Clients tabs so a provider is not shown a list of
 * people she does not treat.
 */
export default async function MembersPage({ searchParams }: Props) {
  const { filter: filterParam, page: pageParam } = await searchParams
  const filter: Filter = (FILTERS as readonly string[]).includes(filterParam ?? '')
    ? (filterParam as Filter)
    : 'all'
  const page = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1)

  const supabase = await createClient()
  const now = requestNow()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/clients/members')

  const [{ data: viewer }, { data: locations }, { data: liveData }, { data: endedData, count: endedCount }] =
    await Promise.all([
      supabase.from('profiles').select('role').eq('id', user.id).maybeSingle(),
      supabase.from('locations').select('timezone, is_active, sort_order').order('sort_order'),
      supabase
        .from('client_memberships')
        .select(MEMBER_SELECT)
        .in('status', ['active', 'past_due'])
        .order('started_at', { ascending: false }),
      supabase
        .from('client_memberships')
        .select(MEMBER_SELECT, { count: 'exact' })
        .in('status', ['cancelled', 'expired'])
        .order('current_period_end', { ascending: false })
        .limit(ENDED_LIMIT),
    ])

  const role = (viewer?.role ?? 'provider') as UserRole
  if (!isFrontDesk(role)) redirect('/dashboard')
  const canManage = isManager(role)

  const sites = locations ?? []
  const timeZone =
    sites.find((l) => l.is_active)?.timezone ?? sites[0]?.timezone ?? 'America/Los_Angeles'

  const live = (liveData ?? []) as unknown as MemberRow[]
  const ended = (endedData ?? []) as unknown as MemberRow[]

  const ids = Array.from(
    new Set([...live, ...(filter === 'ended' ? ended : [])].map((m) => m.client_id))
  )

  // Chunked: PostgREST puts the ids in the URL, and a long member list in one
  // `.in()` is long enough to be refused.
  type Upcoming = { id: string; client_id: string | null; starts_at: string; status: string }
  type Intent = Pick<MembershipBookingIntent, 'client_id' | 'intent' | 'decided_at'>
  const idChunks = chunked(ids)
  const [upcomingParts, intentParts] = await Promise.all([
    Promise.all(
      idChunks.map((part) =>
        supabase
          .from('appointments')
          .select('id, client_id, starts_at, status')
          .in('client_id', part)
          .gt('starts_at', new Date(now).toISOString())
          .in('status', ['pending', 'confirmed'])
          .order('starts_at')
      )
    ),
    Promise.all(
      idChunks.map((part) =>
        supabase
          .from('membership_booking_intents')
          .select('client_id, intent, decided_at')
          .in('client_id', part)
      )
    ),
  ])
  const upcoming: Upcoming[] = upcomingParts.flatMap((r) => r.data ?? [])
  const intents: Intent[] = intentParts.flatMap((r) => r.data ?? [])

  // The soonest booking per client, and every upcoming start for the
  // follow-up rule. Each chunk is ordered and a client sits in one chunk, so
  // the first seen is the soonest.
  const nextVisit = new Map<string, { id: string; starts_at: string; status: string }>()
  const startsBy = new Map<string, string[]>()
  for (const a of upcoming) {
    if (!a.client_id) continue
    if (!nextVisit.has(a.client_id)) nextVisit.set(a.client_id, a)
    startsBy.set(a.client_id, [...(startsBy.get(a.client_id) ?? []), a.starts_at])
  }
  const intentBy = new Map<string, 'now' | 'later'>()
  for (const i of intents) {
    intentBy.set(i.client_id, i.intent)
  }

  function describe(m: MemberRow) {
    const plan = m.memberships as Plan | null
    // An active row past its end date grants nothing, so it has nothing left.
    const current = membershipIsCurrent(m, now)
    const left =
      plan && current
        ? sessionsLeftThisPeriod(
            plan.included_sessions_per_period,
            m.current_period_start,
            (m.membership_redemptions ?? []) as Spent[]
          )
        : 0
    const visit = nextVisit.get(m.client_id) ?? null
    const renewing = m.status === 'active' && m.auto_renew && !m.cancel_at_period_end
    return {
      row: m,
      person: m.profiles as Person | null,
      plan,
      left,
      current,
      visit,
      renewing,
      followUp: needsFollowUp(m, left, startsBy.get(m.client_id) ?? [], now),
    }
  }

  const liveRows = live.map(describe)
  const counts: Record<Filter, number> = {
    all: liveRows.length,
    needs_follow_up: liveRows.filter((r) => r.followUp).length,
    payment_failed: liveRows.filter((r) => r.row.status === 'past_due').length,
    renewing: liveRows.filter((r) => r.renewing).length,
    ended: endedCount ?? ended.length,
  }
  const activeCount = liveRows.filter((r) => r.current).length

  const shown =
    filter === 'ended'
      ? ended.map(describe)
      : filter === 'needs_follow_up'
        ? liveRows.filter((r) => r.followUp)
        : filter === 'payment_failed'
          ? liveRows.filter((r) => r.row.status === 'past_due')
          : filter === 'renewing'
            ? liveRows.filter((r) => r.renewing)
            : liveRows

  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  function hrefFor(n: number, which: Filter = filter): string {
    const params = new URLSearchParams()
    if (which !== 'all') params.set('filter', which)
    if (n > 1) params.set('page', String(n))
    const query = params.toString()
    return query ? `/dashboard/clients/members?${query}` : '/dashboard/clients/members'
  }
  if (page > pageCount && shown.length > 0) redirect(hrefFor(pageCount))
  const pageRows = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const shortDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', {
      timeZone,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })

  return (
    <div>
      <PageHeader
        title="Members"
        lede="Everyone holding a membership, what is left on it this period, and whether they have a visit booked to use it."
      />

      <SectionTabs
        label="View"
        root="/dashboard/clients"
        tabs={[
          { href: '/dashboard/clients', label: 'Clients' },
          { href: '/dashboard/clients/members', label: 'Members' },
          { href: '/dashboard/clients/stubs', label: 'Not signed up' },
          { href: '/dashboard/clients/newsletter', label: 'Newsletter' },
        ]}
      />

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Active members" value={activeCount} />
        <StatTile
          label="Needs follow-up"
          value={counts.needs_follow_up}
          hint="Treatments left, nothing booked"
        />
        <StatTile label="Payment failed" value={counts.payment_failed} />
        <StatTile label="Renewing" value={counts.renewing} hint="Charged by Stripe each period" />
      </div>

      <nav aria-label="Filter members" className="mt-8 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={hrefFor(1, f)}
            aria-current={filter === f ? 'page' : undefined}
            className={`${PILL} ${filter === f ? PILL_ON : PILL_OFF}`}
          >
            {FILTER_LABELS[f]}
            <span className={`tabular-nums ${filter === f ? '' : 'text-[var(--color-muted)]'}`}>
              ({counts[f]})
            </span>
          </Link>
        ))}
      </nav>

      {shown.length === 0 ? (
        <EmptyState
          className="mt-8"
          icon={
            filter === 'needs_follow_up' || filter === 'payment_failed' ? CheckCircle2 : BadgeCheck
          }
          title={
            filter === 'needs_follow_up'
              ? 'Nobody to follow up'
              : filter === 'payment_failed'
                ? 'No failed payments'
                : filter === 'renewing'
                  ? 'Nobody is on auto-renew'
                  : filter === 'ended'
                    ? 'No memberships have ended'
                    : 'No members yet'
          }
          description={
            filter === 'needs_follow_up'
              ? 'Every member with treatments left this period has a visit booked.'
              : filter === 'payment_failed'
                ? 'Every renewal Stripe has tried has gone through.'
                : filter === 'renewing'
                  ? 'Members who choose auto-renew when they join online show here.'
                  : filter === 'ended'
                    ? 'Cancelled and lapsed memberships show here, newest first.'
                    : 'Clients join online from the Membership page, or a manager enrols them from their record.'
          }
          action={
            filter !== 'all' ? (
              <ButtonLink href={hrefFor(1, 'all')} variant="subtle" size="sm">
                Show all members
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <>
          <Panel className="mt-6">
            <div
              className={`label-caps hidden items-center gap-x-6 border-b border-[var(--color-border)] px-5 py-3.5 text-[var(--color-muted)] lg:grid ${COLUMNS}`}
            >
              <span>Member</span>
              <span>Plan</span>
              <span>Left this period</span>
              <span>Renewal</span>
              <span>Next visit</span>
              <span>Booking</span>
              <span />
            </div>

            <ul className="divide-y divide-[var(--color-border)]">
              {pageRows.map(({ row, person, plan, left, current, visit, renewing }) => {
                const name = `${person?.first_name ?? ''} ${person?.last_name ?? ''}`.trim()
                const label = name || person?.email || 'Unnamed client'
                const isEnded = row.status === 'cancelled' || row.status === 'expired'
                const intent = intentBy.get(row.client_id)

                const renewal =
                  row.status === 'past_due' ? (
                    <span className="text-red-700 dark:text-red-400">Payment failed</span>
                  ) : isEnded ? (
                    `Ended ${shortDate(row.ended_at ?? row.current_period_end)}`
                  ) : renewing ? (
                    `Renews ${shortDate(row.current_period_end)}`
                  ) : (
                    `Ends ${shortDate(row.current_period_end)}`
                  )

                return (
                  <li
                    key={row.id}
                    className={`grid items-center gap-x-6 gap-y-2 px-5 py-4 transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)] ${COLUMNS}`}
                  >
                    <div className="flex min-w-0 items-center gap-3.5">
                      <Avatar name={label} />
                      <div className="min-w-0">
                        <Link
                          href={`/dashboard/clients/${row.client_id}`}
                          className="block truncate transition-colors hover:text-[var(--color-accent)]"
                        >
                          {label}
                        </Link>
                        {(person?.phone || person?.email) && (
                          <p className="truncate text-xs text-[var(--color-muted)]">
                            {person?.phone ?? person?.email}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                      <span className="truncate">{plan?.name ?? 'Membership'}</span>
                      <Badge
                        size="sm"
                        tone={
                          row.status === 'past_due'
                            ? 'danger'
                            : isEnded
                              ? 'neutral'
                              : row.cancel_at_period_end
                                ? 'warning'
                                : 'success'
                        }
                      >
                        {row.status === 'active' && row.cancel_at_period_end
                          ? 'Ending'
                          : MEMBERSHIP_STATUS_LABELS[row.status]}
                      </Badge>
                    </div>

                    <div className="text-sm tabular-nums">
                      {!current || !plan ? (
                        <span className="text-[var(--color-muted)]">Not current</span>
                      ) : plan.included_sessions_per_period === 0 ? (
                        <span className="text-[var(--color-muted)]">Discount only</span>
                      ) : (
                        <>
                          {left} of {plan.included_sessions_per_period}
                          <span className="lg:hidden"> left this period</span>
                        </>
                      )}
                    </div>

                    <div className="text-sm text-[var(--color-muted)]">{renewal}</div>

                    <div className="text-sm">
                      {visit ? (
                        <Link
                          href={`/dashboard/appointments/${visit.id}`}
                          className="flex flex-wrap items-center gap-2 transition-colors hover:text-[var(--color-accent)]"
                        >
                          <span className="tabular-nums">
                            {formatDateTimeInTimeZone(new Date(visit.starts_at), timeZone)}
                          </span>
                          <Badge size="sm" tone={visit.status === 'pending' ? 'warning' : 'neutral'}>
                            {visit.status === 'pending' ? 'Pending' : 'Confirmed'}
                          </Badge>
                        </Link>
                      ) : (
                        <span className="text-[var(--color-muted)]">Nothing booked</span>
                      )}
                    </div>

                    <div className="text-sm text-[var(--color-muted)]">
                      {intent === 'now'
                        ? 'Chose: book now'
                        : intent === 'later'
                          ? 'Chose: book later'
                          : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 lg:justify-self-end">
                      {canManage && row.stripe_subscription_id && !isEnded && (
                        <MemberRenewalToggle
                          clientMembershipId={row.id}
                          renewing={renewing}
                          memberName={label}
                        />
                      )}
                      {!visit && !isEnded && (
                        <ButtonLink
                          href={`/dashboard/appointments/book-for-client?client=${row.client_id}`}
                          variant="ghost"
                          size="sm"
                        >
                          <CalendarPlus className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                          Book
                        </ButtonLink>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </Panel>

          {filter === 'ended' && (endedCount ?? 0) > ENDED_LIMIT && (
            <p className="mt-4 text-xs text-[var(--color-muted)]">
              Showing the {ENDED_LIMIT} most recent of {endedCount}.
            </p>
          )}

          <Pagination
            page={page}
            pageCount={pageCount}
            hrefFor={(n) => hrefFor(n)}
            className="mt-8"
          />
        </>
      )}

      <p className="mt-8 flex max-w-prose items-start gap-2 text-xs text-[var(--color-muted)]">
        {filter === 'payment_failed' ? (
          <CreditCard className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
        ) : (
          <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
        )}
        <span>
          Renews means Stripe charges the member each period until they stop. Ends means
          the membership was paid once, or the member stopped renewing, and the benefit
          finishes on that date. Payment failed means Stripe could not take a renewal;
          the benefit is paused until the card is updated.
        </span>
      </p>
    </div>
  )
}
