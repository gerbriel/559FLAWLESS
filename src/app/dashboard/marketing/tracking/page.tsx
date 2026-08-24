import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TrackingSettings } from '@/components/shared/TrackingSettings'
import { PageHeader } from '@/components/ui/dashboard'
import { isAdmin } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * Marketing → Tracking.
 *
 * It sits in Marketing because that is who wants it — the person adding a Meta
 * pixel is running an ad campaign, not administering the site — but it stays
 * admin-only, which is why the tab above is hidden from everyone else.
 *
 * That is not belt-and-braces, it is the UI agreeing with the database. Every
 * other page in this section is manager-gated, while `site_content` carries a
 * single "admin writes site content" policy (migration 009). A manager who
 * reached this form would fill it in, press Save, and get a row-level security
 * error for their trouble — a form that cannot save is worse than one that is
 * not there.
 *
 * The stronger reason is what the fields are. An id here becomes a script tag
 * on every public page, and the custom boxes are arbitrary JavaScript in the
 * same position. Migration 026 says it plainly: a write here is effectively
 * arbitrary JavaScript on every page. That belongs with the role that can
 * already change anything, not with the one that can send a newsletter.
 */
export default async function TrackingPage() {
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

  // Back to the section they can see, rather than out to /dashboard — a manager
  // following a stale link should land somewhere recognisable.
  if (!profile || !isAdmin(profile.role)) redirect('/dashboard/marketing')

  const { data: siteContent } = await supabase
    .from('site_content')
    .select('key, value')
    .in('key', [
      'google_analytics_id',
      'google_tag_manager_id',
      'facebook_pixel_id',
      'tiktok_pixel_id',
      'custom_head_scripts',
      'custom_body_scripts',
    ])

  // The rows are jsonb of two shapes — { id } for the platforms, { scripts }
  // for the free-text boxes — so they are read through one narrow helper rather
  // than six `as any` casts at the call site.
  const byKey = new Map(siteContent?.map((row) => [row.key, row.value]) ?? [])
  const field = (key: string, prop: 'id' | 'scripts'): string => {
    const value = byKey.get(key)
    if (value && typeof value === 'object' && prop in value) {
      const held = (value as Record<string, unknown>)[prop]
      return typeof held === 'string' ? held : ''
    }
    return ''
  }

  return (
    <div>
      <PageHeader
        title="Tracking"
        lede="Analytics and advertising tags for the public site. Nothing here runs in development — the tags are only emitted by a production build, so a value saved now shows up on the live site and nowhere else."
      />

      <div className="mt-8">
        <TrackingSettings
          googleAnalyticsId={field('google_analytics_id', 'id')}
          googleTagManagerId={field('google_tag_manager_id', 'id')}
          facebookPixelId={field('facebook_pixel_id', 'id')}
          tiktokPixelId={field('tiktok_pixel_id', 'id')}
          customHeadScripts={field('custom_head_scripts', 'scripts')}
          customBodyScripts={field('custom_body_scripts', 'scripts')}
        />
      </div>
    </div>
  )
}
