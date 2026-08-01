import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { TestimonialModeration } from '@/components/shared/TestimonialModeration'
import { AnnouncementManager } from '@/components/shared/AnnouncementManager'

export const dynamic = 'force-dynamic'

export default async function MarketingPage() {
  const supabase = await createClient()

  const [{ data: pending }, { data: approved }, { count: subscribers }, { data: announcements }] =
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
        .select('id, title, body, link_url, link_label, variant, starts_at, ends_at, is_active, created_at, target_audience, target_pages, priority')
        .order('created_at', { ascending: false }),
    ])

  return (
    <div className="max-w-3xl">
      <h1 className="display text-3xl">Marketing</h1>

      <div className="mt-8 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3">
        <Link href="/dashboard/marketing/newsletter" className="block hover:opacity-80">
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
          <AnnouncementManager announcements={announcements ?? []} />
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
