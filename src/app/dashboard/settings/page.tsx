import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BookingSettingsForm } from '@/components/shared/BookingSettingsForm'
import { SalesTaxForm } from '@/components/shared/SalesTaxForm'
import { ROLE_LABELS, type UserRole, isAdmin } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const supabase = await createClient()

  const [
    { data: { user } },
    { data: settings },
    { data: staff },
    { data: closures },
    { data: taxSetting },
  ] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from('booking_settings').select('*').eq('id', 1).maybeSingle(),
      supabase
        .from('profiles')
        .select('id, first_name, last_name, email, role, accepts_online_booking, suspended_at')
        .neq('role', 'client')
        .order('role'),
      supabase
        .from('closures')
        .select('id, closure_date, reason')
        .gte('closure_date', new Date().toISOString().slice(0, 10))
        .order('closure_date'),
      supabase
        .from('site_settings')
        .select('text_value')
        .eq('key', 'sales_tax_rate')
        .eq('is_active', true)
        .maybeSingle(),
    ])

  // Fresno County's combined rate is the fallback when nothing has been set.
  const parsedRate = Number(taxSetting?.text_value)
  const taxRate =
    Number.isFinite(parsedRate) && parsedRate >= 0 && parsedRate < 1 ? parsedRate : 0.0835

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user?.id ?? '')
    .maybeSingle()

  const userIsAdmin = profile ? isAdmin(profile.role) : false

  return (
    <div className="max-w-3xl">
      <h1 className="display text-3xl">Settings</h1>

      <section className="mt-10">
        <h2 className="display text-2xl">Booking policy</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          These apply across every provider. Per-service deposits and cancellation
          windows are set on the service itself.
        </p>
        <div className="mt-6">
          {settings ? (
            <BookingSettingsForm settings={settings} />
          ) : (
            <p className="text-sm text-[var(--color-muted)]">
              Settings row missing — run migration 003.
            </p>
          )}
        </div>
      </section>

      <section className="mt-14">
        <div className="flex items-center justify-between">
          <h2 className="display text-2xl">Staff</h2>
          {userIsAdmin && (
            <Link href="/dashboard/settings/users">
              <Button variant="outline" size="sm">
                Manage all users
              </Button>
            </Link>
          )}
        </div>
        <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {(staff ?? []).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div>
                <p className="text-sm">
                  {s.first_name} {s.last_name}
                </p>
                <p className="text-xs text-[var(--color-muted)]">{s.email}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge tone="neutral">{ROLE_LABELS[s.role as UserRole]}</Badge>
                {s.role === 'provider' && (
                  <Badge tone={s.accepts_online_booking ? 'success' : 'warning'}>
                    {s.accepts_online_booking ? 'Bookable' : 'Not bookable'}
                  </Badge>
                )}
                {s.suspended_at && <Badge tone="danger">Suspended</Badge>}
              </div>
            </li>
          ))}
        </ul>
        {userIsAdmin ? (
          <p className="mt-4 text-xs text-[var(--color-muted)]">
            Use the &ldquo;Manage all users&rdquo; button above to edit roles, suspend
            accounts, and view activity logs.
          </p>
        ) : (
          <p className="mt-4 text-xs text-[var(--color-muted)]">
            Only admins can change roles and suspensions.
          </p>
        )}
      </section>

      <section className="mt-14">
        <h2 className="display text-2xl">Sales tax</h2>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          Applied to products rung up at the counter. Services are not taxed.
        </p>
        <div className="mt-6">
          <SalesTaxForm rate={taxRate} />
        </div>
      </section>

      {userIsAdmin && (
        <section className="mt-14">
          <h2 className="display text-2xl">Site and legal</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            The pages clients are asked to agree to, and what appears across the site.
          </p>

          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            <li className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div>
                <p className="text-sm">Privacy Policy and Terms of Service</p>
                <p className="text-xs text-[var(--color-muted)]">
                  Editing either one publishes a new version and keeps the old one, so
                  what a client agreed to on the day stays on the record.
                </p>
              </div>
              <Link href="/dashboard/settings/legal">
                <Button variant="outline" size="sm">
                  Edit
                </Button>
              </Link>
            </li>

            <li className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div>
                <p className="text-sm">Announcements, banners and tracking</p>
                <p className="text-xs text-[var(--color-muted)]">
                  Also reachable from Marketing.
                </p>
              </div>
              <Link href="/dashboard/settings/admin">
                <Button variant="outline" size="sm">
                  Open
                </Button>
              </Link>
            </li>
          </ul>
        </section>
      )}

      <section className="mt-14">
        <h2 className="display text-2xl">Upcoming closures</h2>
        {(closures?.length ?? 0) === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-muted)]">None scheduled.</p>
        ) : (
          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {(closures ?? []).map((c) => (
              <li key={c.id} className="flex justify-between gap-4 py-3 text-sm">
                <span className="tabular-nums">
                  {new Date(`${c.closure_date}T00:00:00`).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'long',
                    day: 'numeric',
                  })}
                </span>
                <span className="text-[var(--color-muted)]">{c.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
