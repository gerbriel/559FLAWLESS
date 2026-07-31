import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import type { ThreadStatus } from '@/types/database'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ status?: string }>
}

const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'pending', label: 'Waiting' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
]

export default async function DashboardMessagesPage({ searchParams }: Props) {
  const { status } = await searchParams
  const active = status ?? 'open'

  const supabase = await createClient()

  let query = supabase
    .from('message_threads')
    .select(
      'id, subject, status, guest_name, guest_email, last_message_at, last_message_from, staff_unread, profiles!message_threads_client_id_fkey(first_name, last_name)'
    )
    .order('last_message_at', { ascending: false })
    .limit(100)

  if (active !== 'all') query = query.eq('status', active as ThreadStatus)

  const { data: threads } = await query

  return (
    <div>
      <h1 className="display text-3xl">Messages</h1>

      <nav className="mt-8 flex flex-wrap gap-x-7 gap-y-2" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/dashboard/messages?status=${f.key}`}
            className={`label-caps pb-1 ${
              active === f.key
                ? 'border-b border-[var(--color-foreground)]'
                : 'text-[var(--color-muted)]'
            }`}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {(threads?.length ?? 0) === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          Nothing here.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {(threads ?? []).map((t) => {
            const client = t.profiles as {
              first_name: string | null
              last_name: string | null
            } | null
            const who = client
              ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()
              : (t.guest_name ?? t.guest_email ?? 'Guest')

            return (
              <li key={t.id}>
                <Link
                  href={`/dashboard/messages/${t.id}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 py-5 transition-colors hover:text-[var(--color-accent)]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-3">
                      {who}
                      {t.staff_unread && <Badge tone="accent">Unread</Badge>}
                      {!client && <Badge tone="neutral">Not linked</Badge>}
                    </p>
                    <p className="mt-1 truncate text-sm text-[var(--color-muted)]">
                      {t.subject}
                    </p>
                  </div>
                  <span className="text-sm text-[var(--color-muted)]">
                    {new Date(t.last_message_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
