import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import {
  BroadcastComposer,
  type UnreachableSubscriber,
} from '@/components/shared/BroadcastComposer'
import { isManager, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * Write to the list.
 *
 * Everyone with an account is reachable in the app; everyone else is listed so
 * the studio can email them by hand. Both numbers are shown up front, because
 * "sent to 40" when 200 are on the list would be misleading.
 */
export default async function BroadcastPage() {
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

  if (!isManager((profile?.role ?? 'provider') as UserRole)) redirect('/dashboard')

  const [{ data: subscribers }, { data: history }] = await Promise.all([
    supabase
      .from('newsletter_subscribers')
      .select('email, first_name, client_id')
      .eq('status', 'active'),
    supabase
      .from('broadcasts')
      .select('id, subject, audience, recipient_count, unreachable_count, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const all = subscribers ?? []
  const reachable = all.filter((s) => s.client_id).length
  const unreachable: UnreachableSubscriber[] = all
    .filter((s) => !s.client_id)
    .map((s) => ({ email: s.email, first_name: s.first_name }))

  return (
    <div>
      <h1 className="display text-3xl">Send newsletter</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
        Write once and it lands in the inbox of everyone on the list who has an account
        here. They can reply, and it comes back as an ordinary conversation.{' '}
        <Link
          href="/dashboard/clients/newsletter"
          className="text-[var(--color-accent)] underline underline-offset-4"
        >
          Who is on the list
        </Link>{' '}
        sits with Clients, since someone can subscribe long before they ever book.
      </p>

      <div className="mt-8">
        <BroadcastComposer reachableCount={reachable} unreachable={unreachable} />
      </div>

      {(history?.length ?? 0) > 0 && (
        <section className="mt-14">
          <h2 className="display text-xl">Already sent</h2>
          <ul className="mt-5 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {(history ?? []).map((b) => (
              <li key={b.id} className="flex flex-wrap items-baseline justify-between gap-4 py-4">
                <div className="min-w-0">
                  <p className="text-sm">{b.subject}</p>
                  <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                    {new Date(b.created_at).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <span className="text-xs tabular-nums text-[var(--color-muted)]">
                  {b.recipient_count} in app
                  {b.unreachable_count > 0 && ` · ${b.unreachable_count} needed email`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
