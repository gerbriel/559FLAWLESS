import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { TestimonialModeration } from '@/components/shared/TestimonialModeration'
import { AdminAnnouncementSettings } from '@/components/shared/AdminAnnouncementSettings'
import { isManager } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function MarketingPage() {
  const supabase = await createClient()

  // Same check as the section layout, repeated here on purpose: a layout does
  // not re-render on a client-side transition, so the tab bar can land someone
  // on this page without the layout's gate running again. Broadcast and
  // Newsletter already self-gate; this is the last page in the section that did
  // not.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/marketing')

  const { data: viewer } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!viewer || !isManager(viewer.role)) redirect('/dashboard')

  const [
    { data: pending },
    { data: approved },
    { count: subscribers },
    { data: announcements },
    { data: stats },
  ] =
    await Promise.all([
      supabase
        .from('testimonials')
        .select('id, client_name, service_name, rating, body, created_at')
        .eq('is_approved', false)
        .order('created_at', { ascending: false }),
      supabase
        .from('testimonials')
        .select('id, client_name, service_name, rating, body, created_at')
        .eq('is_approved', true)
        .order('sort_order')
        .limit(20),
      supabase
        .from('newsletter_subscribers')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'active'),
      supabase
        .from('announcements')
        .select('*')
        .order('created_at', { ascending: false }),
      // Views, clicks and dismissals per announcement, so a promotion that
      // worked is distinguishable from one nobody saw.
      supabase.rpc('announcement_stats'),
    ])

  return (
    <div className="max-w-5xl">
      <h1 className="display text-3xl">Marketing</h1>

      <div className="mt-8 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3">
        {/* A count of people opens the people, not the composer. Both this tile
            and that list read `newsletter_subscribers`, so the number a manager
            clicks is the number they land on. */}
        <Link href="/dashboard/clients/newsletter" className="block hover:opacity-80">
          <Stat label="Newsletter list" value={String(subscribers ?? 0)} />
        </Link>
        <Stat label="Reviews awaiting" value={String(pending?.length ?? 0)} />
        <Stat label="Live reviews" value={String(approved?.length ?? 0)} />
      </div>

      <section className="mt-14">
        <h2 className="display text-2xl">Reviews awaiting approval</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Client-submitted reviews stay hidden until someone approves them.
        </p>

        {(pending?.length ?? 0) === 0 ? (
          <p className="mt-6 text-sm text-[var(--color-muted)]">Nothing waiting.</p>
        ) : (
          <ul className="mt-6 space-y-4">
            {(pending ?? []).map((t) => (
              <li key={t.id}>
                <TestimonialModeration testimonial={t} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-14">
        <h2 className="display text-2xl">Announcements</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          The bar above the site header. Only the most recent live one shows.
        </p>

        <div className="mt-6">
          <AdminAnnouncementSettings announcements={announcements ?? []} stats={stats ?? []} />
        </div>
      </section>
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
