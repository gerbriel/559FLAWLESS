import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SectionTabs } from '@/components/layout/SectionTabs'
import { isAdmin, isManager } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * Marketing, with Analytics folded in.
 *
 * Site traffic and the booking funnel are marketing's own scoreboard — who
 * arrived, where from, and how far they got — so they belong beside the
 * announcements and the list rather than behind a separate sidebar entry.
 * Financial reporting is a different question and stays at /dashboard/reports.
 *
 * The gate here is the section's coarse one. `is_manager()` is already what the
 * SQL side enforces — migration 009's "manager reads analytics" policy and
 * migration 028's `announcement_stats` — so this only makes the UI say out loud
 * what the database was already deciding: without it a provider could open
 * these pages and RLS would hand back empty rows, which reads as a broken page
 * rather than a closed door.
 */
export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Deliberately duplicated: every page in this section repeats this same
  // check, and that is not waste to be tidied up later.
  //
  // Next's own auth guide warns that because of Partial Rendering a layout does
  // not re-render on a client-side transition, so this gate runs on the first
  // load of the section and then never again as someone moves between the tabs
  // above. It cannot be the check that decides who sees a page. The per-page
  // gates are the real ones; this one only spares a viewer who was never
  // allowed in the tab bar and the empty shell behind it.
  //
  // So: do not delete the checks in page.tsx to save the round trip. Deleting
  // this one instead would be the safe economy — the pages would still be
  // closed — but it would let an unauthorised viewer see the section chrome
  // before being bounced.
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

  if (!profile || !isManager(profile.role)) redirect('/dashboard')

  return (
    <div>
      <SectionTabs
        label="Marketing"
        root="/dashboard/marketing"
        // Each label names what its page does, and matches that page's own <h1>.
        // There is no Subscribers tab: /dashboard/marketing/newsletter read a
        // table migration 022 superseded and now forwards to the maintained
        // list at /dashboard/clients/newsletter, which lives under Clients
        // because someone can subscribe long before they ever book.
        tabs={[
          { href: '/dashboard/marketing', label: 'Overview' },
          { href: '/dashboard/marketing/analytics', label: 'Analytics' },
          { href: '/dashboard/marketing/broadcast', label: 'Send newsletter' },
          // Admin like Tracking: a promotion is a pricing decision, and
          // `promotions` (068) only has an admin write policy behind it.
          {
            href: '/dashboard/marketing/promotions',
            label: 'Promotions',
            visible: isAdmin(profile.role),
          },
          // The one tab in this section that is not manager-visible. Tracking
          // writes to site_content, whose only write policy is admin, and its
          // fields put script tags on every public page — so a manager seeing
          // this tab would be an offer the database refuses. The page repeats
          // the check; per the note above, this one only spares them the trip.
          {
            href: '/dashboard/marketing/tracking',
            label: 'Tracking',
            visible: isAdmin(profile.role),
          },
        ]}
      />

      <div className="mt-8">{children}</div>
    </div>
  )
}
