import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Mail, UserCheck, Download } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Input } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import { SectionTabs } from '@/components/layout/SectionTabs'
import { isFrontDesk, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ q?: string; filter?: string }>
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'clients', label: 'Also clients' },
  { key: 'prospects', label: 'Not yet clients' },
  { key: 'unsubscribed', label: 'Unsubscribed' },
]

/**
 * The newsletter list, sitting alongside Clients rather than under Marketing.
 *
 * Someone can subscribe long before they ever book, so a subscription stands on
 * its own record. When an account appears under the same address the two are
 * linked automatically (see migration 022) — which is what turns this from a
 * mailing list into a view of who is in the studio's orbit but has not booked.
 */
export default async function NewsletterPage({ searchParams }: Props) {
  const { q, filter } = await searchParams
  const active = filter ?? 'all'

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!isFrontDesk((profile?.role ?? 'provider') as UserRole)) redirect('/dashboard')

  let query = supabase
    .from('newsletter_subscribers')
    .select('id, email, first_name, status, source, client_id, subscribed_at, unsubscribed_at')
    .order('subscribed_at', { ascending: false })
    .limit(500)

  if (active === 'clients') query = query.not('client_id', 'is', null)
  if (active === 'prospects') query = query.is('client_id', null).eq('status', 'active')
  if (active === 'unsubscribed') query = query.neq('status', 'active')

  if (q?.trim()) {
    query = query.ilike('email', `%${q.trim()}%`)
  }

  const { data: subscribers } = await query
  const rows = subscribers ?? []

  // Name the ones who turned into clients, so the list reads as people.
  const linkedIds = rows.map((r) => r.client_id).filter((id): id is string => !!id)
  const { data: linked } = linkedIds.length
    ? await supabase.from('profiles').select('id, first_name, last_name').in('id', linkedIds)
    : { data: [] }

  const nameById = new Map(
    (linked ?? []).map((p) => [p.id, `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()])
  )

  const clientCount = rows.filter((r) => r.client_id).length
  const activeCount = rows.filter((r) => r.status === 'active').length

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-baseline gap-4">
          <h1 className="display text-3xl">Newsletter</h1>
          <span className="text-sm text-[var(--color-muted)]">
            {activeCount} subscribed · {clientCount} also clients
          </span>
        </div>
        <a
          href="/api/newsletter/export"
          className="label-caps flex min-h-11 items-center gap-2 border border-[var(--color-border)] px-4 hover:border-[var(--color-foreground)]"
        >
          <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
          Export CSV
        </a>
      </div>

      {/* View switcher — the same list of people, three ways in. Every tab is
          unconditional here because the gate above already means the viewer is
          front desk or above, which is exactly who may open any of them. */}
      <SectionTabs
        label="View"
        root="/dashboard/clients"
        tabs={[
          { href: '/dashboard/clients', label: 'Clients' },
          { href: '/dashboard/clients/stubs', label: 'Not signed up' },
          { href: '/dashboard/clients/newsletter', label: 'Newsletter' },
        ]}
      />

      <nav className="mt-6 flex flex-wrap gap-x-6 gap-y-2" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/dashboard/clients/newsletter?filter=${f.key}`}
            className={`text-sm ${
              active === f.key
                ? 'text-[var(--color-foreground)] underline underline-offset-4'
                : 'text-[var(--color-muted)]'
            }`}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      <form className="mt-6 max-w-md">
        <input type="hidden" name="filter" value={active} />
        <Input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search by email"
          aria-label="Search subscribers"
        />
      </form>

      {rows.length === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          {q ? 'Nobody matched that search.' : 'No signups yet.'}
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {rows.map((s) => {
            const name = s.client_id ? nameById.get(s.client_id) : null

            return (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-4 py-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {s.client_id ? (
                      <Link
                        href={`/dashboard/clients/${s.client_id}`}
                        className="text-sm underline underline-offset-4 hover:text-[var(--color-accent)]"
                      >
                        {name || s.email}
                      </Link>
                    ) : (
                      <span className="text-sm">{s.first_name || s.email}</span>
                    )}

                    {s.client_id ? (
                      <Badge tone="success">
                        <UserCheck className="h-3 w-3" strokeWidth={2} />
                        Client
                      </Badge>
                    ) : (
                      <Badge tone="neutral">
                        <Mail className="h-3 w-3" strokeWidth={2} />
                        Subscriber only
                      </Badge>
                    )}

                    {s.status !== 'active' && <Badge tone="warning">{s.status}</Badge>}
                  </div>

                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {s.email}
                    {s.source ? ` · via ${s.source}` : ''}
                  </p>
                </div>

                <span className="text-xs tabular-nums text-[var(--color-muted)]">
                  {new Date(s.subscribed_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <p className="mt-8 max-w-prose text-xs text-[var(--color-muted)]">
        Someone who signs up here and later creates an account is matched on their email
        address automatically, and shows as a client above. Until then their signup is kept
        on its own.
      </p>
    </div>
  )
}
