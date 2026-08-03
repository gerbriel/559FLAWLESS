import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SectionTabs } from '@/components/layout/SectionTabs'
import { isFrontDesk, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * Prepaid packages — the list the studio sells, and the balances people hold.
 *
 * Two screens, one job, so they share a heading and a tab bar rather than two
 * sidebar rows. Which one you want depends on whether you are pricing a course
 * or looking at what somebody already paid for.
 *
 * The section is front desk and up. `client_packages` is `is_front_desk()` for
 * select (008) and a provider simply cannot read it, so a provider following a
 * link here would get a heading over an empty list with nothing explaining
 * why. The redirect is the honest version of that; RLS is still what decides.
 */
export default async function PackagesLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/packages')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  // Least privilege on a missing profile, matching every other section gate.
  if (!isFrontDesk((profile?.role ?? 'provider') as UserRole)) redirect('/dashboard')

  return (
    <div>
      <h1 className="display text-3xl">Packages</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
        A course of treatments bought up front and drawn down a session at a time. The
        client pays once, at the till; every visit it covers is then settled against the
        balance rather than charged again.
      </p>

      <SectionTabs
        label="Packages"
        root="/dashboard/packages"
        tabs={[
          { href: '/dashboard/packages', label: 'Catalogue' },
          { href: '/dashboard/packages/balances', label: 'Balances' },
        ]}
      />

      <div className="mt-10">{children}</div>
    </div>
  )
}
