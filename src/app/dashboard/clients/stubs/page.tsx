import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowUpRight, SearchX, UserPlus, Users } from 'lucide-react'
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
import { SectionTabs } from '@/components/layout/SectionTabs'
import { requestNow } from '@/lib/time'
import { isFrontDesk, isManager, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/** Same page as the client roster, for the same reason — see that file. */
const PAGE_SIZE = 25

const COLUMNS = 'sm:grid-cols-[minmax(0,1.7fr)_minmax(0,1.7fr)_minmax(0,1fr)_auto_2.75rem]'

const ROW_ACTION =
  'flex h-11 w-11 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-foreground)] sm:h-9 sm:w-9'

const SOURCE_LABEL: Record<string, string> = {
  import: 'Imported',
  manual: 'Added by hand',
  walk_in: 'Walk-in',
}

interface Props {
  searchParams: Promise<{ q?: string; page?: string; show?: string }>
}

/**
 * The people the studio knows and has not signed up yet.
 *
 * A separate screen rather than a filter on the roster, because these are not
 * clients in the sense the roster means it: no account, no appointments, no
 * lifetime value, nothing on file. Half of that list's columns would be blank
 * for every one of them, and the count at the top of it — the number the studio
 * quotes as "how many clients we have" — would quietly start including people
 * who have never been through the door under this system.
 *
 * They stay findable from the roster all the same: a search there also looks
 * here and says so. What this screen adds is the question the roster cannot
 * ask, which is "who is still to invite".
 *
 * Front desk and above, matching Newsletter next door. 051 lets any staff
 * member read the table, but inviting is front-desk work and a screen whose
 * every action is refused is worse than no screen.
 */
export default async function ClientStubsPage({ searchParams }: Props) {
  const { q, page: pageParam, show } = await searchParams
  const supabase = await createClient()
  const now = requestNow()

  const term = q?.trim() ?? ''
  const page = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE
  const showClaimed = show === 'claimed'

  function hrefFor(n: number): string {
    const params = new URLSearchParams()
    if (term) params.set('q', term)
    if (showClaimed) params.set('show', 'claimed')
    if (n > 1) params.set('page', String(n))
    const query = params.toString()
    return query ? `/dashboard/clients/stubs?${query}` : '/dashboard/clients/stubs'
  }

  let query = supabase
    .from('client_stubs')
    .select(
      'id, first_name, last_name, email, phone, note, source, import_batch, claimed_by, claimed_at, created_at',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)

  // Claimed stubs are history — the account exists and the roster has them.
  // Kept reachable rather than hidden, because "did that import actually land
  // anybody" is a fair question to ask of this screen.
  if (!showClaimed) query = query.is('claimed_by', null)

  if (term) {
    const pattern = `%${term}%`
    query = query.or(
      `first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern}`
    )
  }

  const [
    {
      data: { user },
    },
    { data: stubs, count },
  ] = await Promise.all([supabase.auth.getUser(), query])

  if (!user) redirect('/login?next=/dashboard/clients/stubs')

  const { data: viewer } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  const role = (viewer?.role ?? 'provider') as UserRole
  if (!isFrontDesk(role)) redirect('/dashboard')

  const total = count ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  if (page > pageCount && total > 0) redirect(hrefFor(pageCount))

  // Who has a link out already, so the list answers "have we asked them yet"
  // rather than only "are they still waiting". Scoped to the rows on screen.
  const ids = (stubs ?? []).map((s) => s.id)
  const { data: invitations } = ids.length
    ? await supabase
        .from('invitations')
        .select('id, client_stub_id, expires_at, accepted_at, revoked_at')
        .in('client_stub_id', ids)
    : { data: [] }

  const inviteState = new Map<number, 'pending' | 'expired' | 'accepted'>()
  for (const invitation of invitations ?? []) {
    const stubId = invitation.client_stub_id
    if (!stubId) continue
    const state = invitation.accepted_at
      ? 'accepted'
      : invitation.revoked_at
        ? null
        : new Date(invitation.expires_at).getTime() > now
          ? 'pending'
          : 'expired'
    if (!state) continue
    // A live link outranks an expired one; the row should read as the newest
    // true thing about them, not as whichever invitation came back first.
    const held = inviteState.get(stubId)
    if (held === 'accepted' || (held === 'pending' && state === 'expired')) continue
    inviteState.set(stubId, state)
  }

  const shown = stubs?.length ?? 0
  const lede =
    total === 0
      ? undefined
      : term
        ? `${total} ${total === 1 ? 'match' : 'matches'} for “${term}”.`
        : showClaimed
          ? `${total} on the list, including the ones who have since signed up.`
          : `${total} ${total === 1 ? 'person' : 'people'} to invite, newest first${
              pageCount > 1 ? ` — showing ${offset + 1}–${offset + shown}` : ''
            }.`

  return (
    <div>
      <PageHeader
        title="Not signed up"
        lede={
          lede ?? 'People the studio knows who have no account yet.'
        }
      />

      <SectionTabs
        label="View"
        root="/dashboard/clients"
        tabs={[
          { href: '/dashboard/clients', label: 'Clients' },
          { href: '/dashboard/clients/stubs', label: 'Not signed up' },
          { href: '/dashboard/clients/newsletter', label: 'Newsletter' },
        ]}
      />

      <p className="mt-6 max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
        A contact and an intention: somebody on the studio&rsquo;s old list, or a walk-in
        nobody has signed up. Open a record and send them an invitation — they set their
        own password, and what the studio already knows carries across rather than
        becoming a second copy of the same person.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        {/* A GET form, so the search is in the URL like everywhere else here. */}
        <form role="search" className="w-full max-w-xl">
          {showClaimed && <input type="hidden" name="show" value="claimed" />}
          <SearchField name="q" defaultValue={q ?? ''} label="Search by name, email, or phone" />
        </form>

        <Link
          href={
            showClaimed
              ? `/dashboard/clients/stubs${term ? `?q=${encodeURIComponent(term)}` : ''}`
              : `/dashboard/clients/stubs?show=claimed${term ? `&q=${encodeURIComponent(term)}` : ''}`
          }
          className="text-sm text-[var(--color-muted)] underline underline-offset-4 hover:text-[var(--color-foreground)]"
        >
          {showClaimed ? 'Only those still waiting' : 'Include the ones who signed up'}
        </Link>
      </div>

      {total === 0 ? (
        term ? (
          <EmptyState
            className="mt-8"
            icon={SearchX}
            title="Nothing matched that search"
            description={`No name, email address or phone number on this list contains “${term}”.`}
            action={
              <ButtonLink href="/dashboard/clients/stubs" variant="subtle" size="sm">
                Show everyone waiting
              </ButtonLink>
            }
          />
        ) : (
          <EmptyState
            className="mt-8"
            icon={Users}
            title={showClaimed ? 'Nobody has been on this list' : 'Everybody has an account'}
            description={
              showClaimed
                ? 'Import a client list, or add someone by hand, and they wait here until they are invited.'
                : 'Nobody is waiting to be invited. Imported clients with no email address land here.'
            }
            // The importer is manager-and-above (see the gate on that page), so
            // front desk is told where these people come from rather than
            // offered a door that closes on them.
            action={
              isManager(role) ? (
                <ButtonLink href="/dashboard/settings/data" variant="subtle" size="sm">
                  Import a client list
                </ButtonLink>
              ) : undefined
            }
          />
        )
      ) : (
        <>
          <Panel className="mt-8 overflow-hidden">
            <div
              aria-hidden
              className={`label-caps hidden gap-x-6 border-b border-[var(--color-border)] px-5 py-3.5 text-[var(--color-muted)] sm:grid ${COLUMNS}`}
            >
              <span>Name</span>
              <span>Email</span>
              <span>Phone</span>
              <span className="text-right">Where from</span>
              <span />
            </div>

            <ul className="divide-y divide-[var(--color-border)]">
              {(stubs ?? []).map((stub) => {
                const name = `${stub.first_name} ${stub.last_name ?? ''}`.trim()
                const state = inviteState.get(stub.id)

                return (
                  <li
                    key={stub.id}
                    className={`relative grid items-center gap-x-6 gap-y-2 px-5 py-4 transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)] ${COLUMNS}`}
                  >
                    <div className="flex min-w-0 items-center gap-3.5 pr-12 sm:pr-0">
                      <Avatar name={name} />
                      <div className="min-w-0">
                        <Link
                          href={`/dashboard/clients/stubs/${stub.id}`}
                          className="block truncate transition-colors hover:text-[var(--color-accent)]"
                        >
                          {name}
                        </Link>

                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {stub.claimed_by ? (
                            <Badge tone="success" size="sm">
                              Signed up
                            </Badge>
                          ) : state === 'pending' ? (
                            <Badge tone="info" size="sm">
                              Invited
                            </Badge>
                          ) : state === 'expired' ? (
                            <Badge tone="warning" size="sm">
                              Invitation expired
                            </Badge>
                          ) : (
                            <Badge tone="neutral" size="sm">
                              Not invited
                            </Badge>
                          )}
                          {!stub.email && !stub.claimed_by && (
                            <Badge tone="neutral" size="sm">
                              No email yet
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="min-w-0 text-sm text-[var(--color-muted)]">
                      {stub.email ? (
                        <a
                          href={`mailto:${stub.email}`}
                          className="block truncate transition-colors hover:text-[var(--color-foreground)]"
                        >
                          {stub.email}
                        </a>
                      ) : (
                        <span className="hidden sm:block" aria-hidden>
                          —
                        </span>
                      )}
                    </div>

                    <div className="text-sm text-[var(--color-muted)]">
                      {stub.phone ? (
                        <a
                          href={`tel:${stub.phone}`}
                          className="transition-colors hover:text-[var(--color-foreground)]"
                        >
                          {stub.phone}
                        </a>
                      ) : (
                        <span className="hidden sm:block" aria-hidden>
                          —
                        </span>
                      )}
                    </div>

                    <div className="text-sm text-[var(--color-muted)] sm:text-right">
                      {SOURCE_LABEL[stub.source] ?? stub.source}
                    </div>

                    <div className="absolute right-4 top-4 sm:static sm:justify-self-end">
                      <Link href={`/dashboard/clients/stubs/${stub.id}`} className={ROW_ACTION}>
                        {stub.claimed_by ? (
                          <ArrowUpRight className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                        ) : (
                          <UserPlus className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                        )}
                        <span className="sr-only">Open {name}&rsquo;s record</span>
                      </Link>
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
