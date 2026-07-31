import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function MessagesPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: threads } = await supabase
    .from('message_threads')
    .select('id, subject, status, last_message_at, last_message_from, client_unread')
    .eq('client_id', user.id)
    .order('last_message_at', { ascending: false })

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Messages</h1>
        <ButtonLink href="/contact" size="sm" variant="subtle">
          New message
        </ButtonLink>
      </div>

      {(threads?.length ?? 0) === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          No messages yet. Questions about a treatment, aftercare, or your booking are all
          fair game.
        </p>
      ) : (
        <ul className="mt-10 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {(threads ?? []).map((t) => (
            <li key={t.id}>
              <Link
                href={`/account/messages/${t.id}`}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 py-5 transition-colors hover:text-[var(--color-accent)]"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-3">
                    {t.subject}
                    {t.client_unread && <Badge tone="accent">New reply</Badge>}
                  </p>
                  <p className="mt-1 text-sm text-[var(--color-muted)]">
                    Last from {t.last_message_from ?? 'you'}
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
          ))}
        </ul>
      )}
    </div>
  )
}
