import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AdminContentSettings } from '@/components/shared/AdminContentSettings'
import { AdminAnnouncementSettings } from '@/components/shared/AdminAnnouncementSettings'
import { isAdmin } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function AdminSettingsPage() {
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

  // Only admins can access this page
  if (!profile || !isAdmin(profile.role)) {
    redirect('/dashboard')
  }

  // Fetch existing settings from site_content table
  const { data: siteContent } = await supabase
    .from('site_content')
    .select('key, value, label')
    .in('key', [
      'privacy_policy',
      'terms_of_service',
    ])

  const contentMap = new Map(
    siteContent?.map(item => [item.key, item.value]) ?? []
  )

  // Fetch active announcements
  const { data: announcements } = await supabase
    .from('announcements')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20)

  return (
    <div>
      <h1 className="display text-3xl">Admin Settings</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        Legal content and site-wide announcements. Tracking now lives under Marketing.
      </p>

      <div className="mt-12 space-y-12">
        {/* Legal Content */}
        <section>
          <h2 className="display mb-6 text-2xl">Legal Content</h2>
          <p className="mb-6 text-sm text-[var(--color-muted)]">
            Edit privacy policy and terms of service. Changes are versioned and tracked.
          </p>
          <AdminContentSettings
            privacyPolicy={(contentMap.get('privacy_policy') as any)?.text ?? ''}
            termsOfService={(contentMap.get('terms_of_service') as any)?.text ?? ''}
          />
        </section>

        {/* Tracking moved to Marketing → Tracking, where the person who wants a
            pixel is already working. It stays admin-only there. */}

        {/* Announcements */}
        <section>
          <h2 className="display mb-6 text-2xl">Announcements</h2>
          <p className="mb-6 text-sm text-[var(--color-muted)]">
            Create and manage site-wide announcement banners
          </p>
          <AdminAnnouncementSettings announcements={announcements ?? []} />
        </section>
      </div>
    </div>
  )
}
