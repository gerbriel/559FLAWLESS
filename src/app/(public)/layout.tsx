import { Suspense } from 'react'
import { createPublicClient } from '@/lib/supabase/public'
import { SiteHeader } from '@/components/layout/SiteHeader'
import { SiteFooter, type FooterContact } from '@/components/layout/SiteFooter'
import { AnnouncementBar } from '@/components/layout/AnnouncementBar'
import { AnalyticsTracker } from '@/components/shared/AnalyticsTracker'

/**
 * Everything this layout reads is public, so the whole marketing site can be
 * cached and revalidated rather than rendered per request.
 *
 * It deliberately does NOT call `auth.getUser()`. Doing so reads cookies, which
 * opts the entire subtree into dynamic rendering — every service page, the FAQ,
 * the policies — and adds a Supabase round-trip to each one. The only thing the
 * chrome needed a session for was where to point the account icon, and
 * `/account` sorts that out itself: it redirects anonymous visitors to sign in
 * and staff to the dashboard.
 */
export const revalidate = 300

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = createPublicClient()

  const [{ data: categories }, { data: announcements }, { data: hours }, { data: contactRow }] =
    await Promise.all([
      supabase
        .from('service_categories')
        .select('name, slug, services(name, slug, sort_order, is_active)')
        .eq('is_active', true)
        .order('sort_order'),
      supabase
        .from('announcements')
        .select('id, title, link_url, link_label, variant')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1),
      supabase.from('business_hours').select('*'),
      supabase.from('site_content').select('value').eq('key', 'contact').maybeSingle(),
    ])

  const nav = (categories ?? []).map((c) => ({
    name: c.name,
    slug: c.slug,
    services: ((c.services ?? []) as { name: string; slug: string; sort_order: number; is_active: boolean }[])
      .filter((s) => s.is_active)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({ name: s.name, slug: s.slug })),
  }))

  const announcement = announcements?.[0]
  const contact = (contactRow?.value ?? {}) as FooterContact

  return (
    <>
      {announcement && (
        <AnnouncementBar
          id={announcement.id}
          title={announcement.title}
          linkUrl={announcement.link_url}
          linkLabel={announcement.link_label}
          variant={announcement.variant}
        />
      )}

      <SiteHeader categories={nav} />

      <main className="flex-1">{children}</main>

      <SiteFooter
        contact={contact}
        hours={hours ?? []}
        categories={nav.map((c) => ({ name: c.name, slug: c.slug }))}
      />

      <Suspense fallback={null}>
        <AnalyticsTracker />
      </Suspense>
    </>
  )
}
