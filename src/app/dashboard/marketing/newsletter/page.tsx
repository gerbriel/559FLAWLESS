import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { isManager } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function NewsletterPage() {
  const supabase = await createClient()

  // Check authentication and authorization
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  // Only managers and admins can access newsletter management
  if (!profile || !isManager(profile.role)) {
    redirect('/dashboard')
  }

  // Fetch newsletter subscriptions from the new table structure
  const { data: subscriptions } = await supabase
    .from('newsletter_subscriptions')
    .select('id, email, profile_id, is_subscribed, confirmed_at, subscribed_at, source')
    .order('subscribed_at', { ascending: false })
    .limit(500)

  const activeCount =
    subscriptions?.filter((s) => s.is_subscribed && s.confirmed_at)?.length || 0
  const pendingCount =
    subscriptions?.filter((s) => s.is_subscribed && !s.confirmed_at)?.length || 0
  const unsubscribedCount = subscriptions?.filter((s) => !s.is_subscribed)?.length || 0

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="display text-3xl">Newsletter Subscribers</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Manage newsletter subscriptions and view consent audit trail
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="mt-8 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3">
        <Stat label="Active subscribers" value={String(activeCount)} />
        <Stat label="Pending confirmation" value={String(pendingCount)} />
        <Stat label="Unsubscribed" value={String(unsubscribedCount)} />
      </div>

      <div className="mt-8 border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)]">
              <tr>
                <th className="px-6 py-4 font-medium">Email</th>
                <th className="px-6 py-4 font-medium">Status</th>
                <th className="px-6 py-4 font-medium">Source</th>
                <th className="px-6 py-4 font-medium">Subscribed</th>
                <th className="px-6 py-4 font-medium">Profile</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {subscriptions?.map((sub) => (
                <tr key={sub.id} className="hover:bg-[var(--color-background)]">
                  <td className="px-6 py-4">{sub.email}</td>
                  <td className="px-6 py-4">
                    {sub.is_subscribed && sub.confirmed_at && (
                      <Badge tone="success">Active</Badge>
                    )}
                    {sub.is_subscribed && !sub.confirmed_at && (
                      <Badge tone="warning">Pending</Badge>
                    )}
                    {!sub.is_subscribed && <Badge tone="neutral">Unsubscribed</Badge>}
                  </td>
                  <td className="px-6 py-4 capitalize text-[var(--color-muted)]">
                    {sub.source || '—'}
                  </td>
                  <td className="px-6 py-4 text-[var(--color-muted)]">
                    {new Date(sub.subscribed_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4">
                    {sub.profile_id ? (
                      <Link
                        href={`/dashboard/clients/${sub.profile_id}`}
                        className="text-[var(--color-accent)] underline underline-offset-4"
                      >
                        View Profile
                      </Link>
                    ) : (
                      <span className="text-[var(--color-muted)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-8 border-t border-[var(--color-border)] pt-8">
        <h3 className="label-caps mb-4 text-[var(--color-accent)]">Compliance Notes</h3>
        <ul className="space-y-2 text-sm text-[var(--color-muted)]">
          <li>
            • All consent is tracked with IP addresses and timestamps for CAN-SPAM/GDPR/CCPA
            compliance
          </li>
          <li>
            • Unsubscribe tokens never expire — one-click unsubscribe works indefinitely
          </li>
          <li>• Double opt-in is enforced for footer signups</li>
          <li>• Authenticated signups are auto-confirmed (lower friction, verified email)</li>
          <li>
            • Full audit trail available in{' '}
            <code className="rounded bg-[var(--color-surface)] px-1 text-xs">
              consent_audit_log
            </code>{' '}
            table
          </li>
        </ul>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--color-background)] p-6">
      <p className="label-caps text-[var(--color-muted)]">{label}</p>
      <p className="display mt-2 text-3xl tabular-nums">{value}</p>
    </div>
  )
}
