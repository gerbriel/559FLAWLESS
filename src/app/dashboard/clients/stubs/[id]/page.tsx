import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { Panel } from '@/components/ui/dashboard'
import {
  StubInviteManager,
  type StubInvitationRow,
} from '@/components/shared/StubInviteManager'
import { formatDateInTimeZone, requestNow } from '@/lib/time'
import { isFrontDesk, isStaff, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

const SOURCE_LABEL: Record<string, string> = {
  import: 'Imported from a spreadsheet',
  manual: 'Added by hand',
  walk_in: 'Walk-in',
}

interface Props {
  params: Promise<{ id: string }>
}

/**
 * One person on the studio's list who has no account.
 *
 * The client record's smaller sibling, and deliberately much smaller: there is
 * no history to show, because 051 forbids a stub from having any. No
 * appointments, no orders, no notes, nothing clinical. What is here is what
 * somebody typed on a piece of paper or pasted out of a spreadsheet, plus the
 * one action that matters — invite them, and let them turn it into a real
 * record themselves.
 *
 * Once claimed the page keeps working and says so, pointing at the account it
 * became. A record that vanishes the moment it succeeds is a record that looks
 * like a bug to whoever bookmarked it.
 */
export default async function ClientStubPage({ params }: Props) {
  const { id } = await params
  const stubId = Number.parseInt(id, 10)
  if (!Number.isSafeInteger(stubId) || stubId < 1) notFound()

  const supabase = await createClient()
  const now = requestNow()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=/dashboard/clients/stubs/${id}`)

  const [{ data: stub }, { data: viewer }, { data: locations }] = await Promise.all([
    supabase
      .from('client_stubs')
      .select(
        'id, first_name, last_name, email, phone, note, source, import_batch, claimed_by, claimed_at, created_at, claimant:profiles!client_stubs_claimed_by_fkey(id, first_name, last_name, email), author:profiles!client_stubs_created_by_fkey(first_name, last_name, display_name)'
      )
      .eq('id', stubId)
      .maybeSingle(),
    supabase.from('profiles').select('role').eq('id', user.id).maybeSingle(),
    supabase.from('locations').select('timezone, is_active, sort_order').order('sort_order'),
  ])

  const role = (viewer?.role ?? 'provider') as UserRole
  if (!isStaff(role)) redirect('/dashboard')

  // No row means the id is wrong or RLS filtered it out. Either way there is
  // nothing here to show.
  if (!stub) notFound()

  // Invitations are front-desk-and-up to read (031), so a provider's query
  // comes back empty rather than erroring — which is why the panel below is
  // only rendered for the people who can act on it.
  const { data: invitations } = isFrontDesk(role)
    ? await supabase
        .from('invitations')
        .select(
          'id, email, note, expires_at, accepted_at, revoked_at, created_at, inviter:profiles!invitations_invited_by_fkey(first_name, last_name, display_name)'
        )
        .eq('client_stub_id', stubId)
        .order('created_at', { ascending: false })
        .limit(20)
    : { data: [] }

  const sites = locations ?? []
  const timeZone =
    sites.find((l) => l.is_active)?.timezone ?? sites[0]?.timezone ?? 'America/Los_Angeles'

  const name = `${stub.first_name} ${stub.last_name ?? ''}`.trim()
  const claimant = stub.claimant as unknown as {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  } | null
  const author = stub.author as unknown as {
    first_name: string | null
    last_name: string | null
    display_name: string | null
  } | null
  const addedBy =
    author?.display_name || `${author?.first_name ?? ''} ${author?.last_name ?? ''}`.trim()

  return (
    <div>
      <Link href="/dashboard/clients/stubs" className="label-caps text-[var(--color-muted)]">
        ← Not signed up
      </Link>

      <div className="mt-8 flex flex-wrap items-start justify-between gap-6">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="display text-3xl">{name}</h1>
            {stub.claimed_by ? (
              <Badge tone="success">
                <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
                Signed up
              </Badge>
            ) : (
              <Badge tone="neutral">No account yet</Badge>
            )}
          </div>

          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {stub.email ?? 'No email address'}
            {stub.phone && ` · ${stub.phone}`}
          </p>
        </div>

        {claimant && (
          <ButtonLink href={`/dashboard/clients/${claimant.id}`} variant="primary" size="sm">
            Open their client record
          </ButtonLink>
        )}
      </div>

      {/* The happy ending, stated plainly. Everything below it is what the
          studio knew before the account existed, kept because it is where the
          account came from. */}
      {stub.claimed_by && (
        <Panel className="mt-8 border-emerald-600/40 bg-emerald-50 p-5 text-sm dark:bg-transparent">
          <p>
            Claimed{' '}
            {stub.claimed_at && formatDateInTimeZone(new Date(stub.claimed_at), timeZone)} by{' '}
            <span className="font-medium">
              {`${claimant?.first_name ?? ''} ${claimant?.last_name ?? ''}`.trim() ||
                claimant?.email ||
                'their new account'}
            </span>
            . Anything the studio had and the signup form did not ask for — a phone
            number, usually — was copied across to that account.
          </p>
        </Panel>
      )}

      <div className="mt-10 grid gap-10 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-10">
          {isFrontDesk(role) && !stub.claimed_by && (
            <StubInviteManager
              stub={{
                id: stub.id,
                first_name: stub.first_name,
                last_name: stub.last_name,
                email: stub.email,
              }}
              invitations={(invitations ?? []) as unknown as StubInvitationRow[]}
              canInvite
              timeZone={timeZone}
              now={now}
            />
          )}

          {/* Free text somebody pasted in. Explicitly not clinical — 051 says
              so, and nothing on this page may become a place to record health
              information about a person who has not consented to it being
              held. It reads as what it is: an old note about a contact. */}
          {stub.note && (
            <Panel className="p-6">
              <h2 className="label-caps mb-4 text-[var(--color-accent)]">What the list said</h2>
              <p className="whitespace-pre-line text-sm leading-relaxed">{stub.note}</p>
              <p className="mt-4 text-xs text-[var(--color-muted)]">
                Notes from the old list, kept as written. Treatment notes and intake
                belong on the client record once they have an account.
              </p>
            </Panel>
          )}
        </div>

        <aside className="space-y-8">
          <Panel className="p-6">
            <h2 className="label-caps mb-5 text-[var(--color-accent)]">On file</h2>
            <dl className="space-y-3 text-sm">
              <Row label="Name" value={name} />
              <Row label="Email" value={stub.email ?? '—'} />
              <Row label="Phone" value={stub.phone ?? '—'} />
              <Row label="Source" value={SOURCE_LABEL[stub.source] ?? stub.source} />
              {stub.import_batch && <Row label="Batch" value={stub.import_batch} />}
              <Row
                label="Added"
                value={formatDateInTimeZone(new Date(stub.created_at), timeZone)}
              />
              {addedBy && <Row label="Added by" value={addedBy} />}
            </dl>
          </Panel>

          {!stub.claimed_by && (
            <Panel className="p-6">
              <h2 className="label-caps mb-4 text-[var(--color-accent)]">Booking them now</h2>
              <p className="text-sm leading-relaxed text-[var(--color-muted)]">
                They do not need an account first. Book them as a guest and the visit
                attaches itself to their profile the moment one exists, matched on the
                email address or the phone number.
              </p>
              {isFrontDesk(role) && (
                <div className="mt-4">
                  <ButtonLink
                    href="/dashboard/appointments/book-for-client"
                    variant="subtle"
                    size="sm"
                  >
                    Book an appointment
                  </ButtonLink>
                </div>
              )}
            </Panel>
          )}
        </aside>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="min-w-0 break-words text-right">{value}</dd>
    </div>
  )
}
