import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Clock, ShieldCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ServiceEditor, type EditableService } from '@/components/shared/ServiceEditor'
import { formatMoney } from '@/lib/utils'
import { isManager, isAdmin, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * The service menu, editable in place.
 *
 * Grouped by category because that is how it reads on the public site — seeing
 * the same shape here makes it obvious what a price change will look like to a
 * client.
 */
export default async function ServicesPage() {
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

  const role = (profile?.role ?? 'provider') as UserRole
  const canEdit = isManager(role)
  const admin = isAdmin(role)

  const [{ data: categories }, { data: services }] = await Promise.all([
    supabase
      .from('service_categories')
      .select('id, name, is_active, sort_order')
      .order('sort_order'),
    supabase
      .from('services')
      .select(
        'id, category_id, name, slug, description, details, aftercare, price_cents, price_is_starting, duration_minutes, buffer_minutes, is_active, is_featured, sort_order, is_intimate, requires_age_verification, min_age, requires_consultation, patch_test_hours, deposit_cents, cancellation_window_hours'
      )
      .order('sort_order')
      .order('name'),
  ])

  const cats = categories ?? []
  const options = cats.map((c) => ({ id: c.id, name: c.name }))
  const all = (services ?? []) as EditableService[]

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="display text-3xl">Services</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {all.filter((s) => s.is_active).length} listed · {all.length} total
          </p>
        </div>
        {canEdit && options.length > 0 && (
          <ServiceEditor categories={options} isAdmin={admin} />
        )}
      </div>

      {canEdit && (
        <nav className="mt-8 flex flex-wrap gap-x-7 gap-y-2" aria-label="View">
          <Link
            href="/dashboard/services"
            className="label-caps border-b border-[var(--color-foreground)] pb-1"
          >
            Services
          </Link>
          <Link
            href="/dashboard/services/forms"
            className="label-caps pb-1 text-[var(--color-muted)]"
          >
            Consent forms
          </Link>
        </nav>
      )}

      {canEdit && !admin && (
        <p className="mt-8 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm text-[var(--color-muted)] dark:bg-[var(--color-surface)]">
          You can edit names, prices, durations and copy. Age gates, patch tests and
          deposits are set by an admin.
        </p>
      )}

      {cats.map((cat) => {
        const rows = all.filter((s) => s.category_id === cat.id)
        if (rows.length === 0) return null

        return (
          <section key={cat.id} className="mt-12">
            <div className="flex items-baseline gap-3">
              <h2 className="display text-xl">{cat.name}</h2>
              {!cat.is_active && <Badge tone="neutral">Category hidden</Badge>}
            </div>

            <ul className="mt-5 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
              {rows.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-start justify-between gap-4 py-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={s.is_active ? '' : 'text-[var(--color-muted)] line-through'}>
                        {s.name}
                      </span>
                      {!s.is_active && <Badge tone="neutral">Not listed</Badge>}
                      {s.is_featured && <Badge tone="accent">Featured</Badge>}
                      {s.requires_age_verification && (
                        <Badge tone="warning">
                          <ShieldCheck className="h-3 w-3" strokeWidth={2} />
                          {s.min_age}+
                        </Badge>
                      )}
                      {s.requires_consultation && <Badge tone="neutral">Consult first</Badge>}
                      {s.patch_test_hours > 0 && (
                        <Badge tone="neutral">Patch test {s.patch_test_hours}h</Badge>
                      )}
                    </div>

                    {s.description && (
                      <p className="mt-1 max-w-prose text-sm text-[var(--color-muted)]">
                        {s.description}
                      </p>
                    )}

                    <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" strokeWidth={1.75} />
                        {s.duration_minutes} min
                        {s.buffer_minutes > 0 && ` + ${s.buffer_minutes} turnaround`}
                      </span>
                      {s.deposit_cents > 0 && (
                        <span>{formatMoney(s.deposit_cents)} deposit</span>
                      )}
                    </p>
                  </div>

                  <div className="flex items-center gap-4">
                    <span className="tabular-nums">
                      {s.price_is_starting && (
                        <span className="label-caps mr-1 text-[var(--color-muted)]">from</span>
                      )}
                      {formatMoney(s.price_cents)}
                    </span>
                    {canEdit && (
                      <ServiceEditor service={s} categories={options} isAdmin={admin} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )
      })}

      {all.length === 0 && (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          No services yet.
        </p>
      )}
    </div>
  )
}
