import { Suspense } from 'react'
import { createPublicClient } from '@/lib/supabase/public'
import { createClient } from '@/lib/supabase/server'
import { SiteHeader } from '@/components/layout/SiteHeader'
import { SiteFooter, type FooterContact } from '@/components/layout/SiteFooter'
import { AnnouncementDisplay } from '@/components/shared/AnnouncementDisplay'
import { ClientAnalytics } from '@/components/shared/ClientAnalytics'

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
  const authSupabase = await createClient()

  // Get user role for announcement targeting (optional, doesn't force dynamic rendering)
  let userRole: string | undefined
  try {
    const {
      data: { user },
    } = await authSupabase.auth.getUser()
    if (user) {
      const { data: profile } = await authSupabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle()
      userRole = profile?.role
    }
  } catch {
    // Anonymous is fine
  }

  const [{ data: categories }, { data: hours }, { data: contactRow }] = await Promise.all([
    supabase
      .from('service_categories')
      .select('name, slug, services(name, slug, sort_order, is_active)')
      .eq('is_active', true)
      .order('sort_order'),
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

  const contact = (contactRow?.value ?? {}) as FooterContact

  return (
    <>
      <AnnouncementDisplay userRole={userRole} />

      <SiteHeader categories={nav} />

      <main className="flex-1">{children}</main>

      <SiteFooter
        contact={contact}
        hours={hours ?? []}
        categories={nav.map((c) => ({ name: c.name, slug: c.slug }))}
      />

      <Suspense fallback={null}>
        <ClientAnalytics />
      </Suspense>
    </>
  )
}
