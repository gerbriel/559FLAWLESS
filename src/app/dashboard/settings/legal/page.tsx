import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LegalContentEditor } from '@/components/shared/LegalContentEditor'

export const dynamic = 'force-dynamic'

export default async function LegalSettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  // Check admin permission
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') {
    redirect('/dashboard')
  }

  // Fetch current terms and privacy policy
  const [{ data: terms }, { data: privacy }] = await Promise.all([
    supabase
      .from('site_settings')
      .select('*')
      .eq('key', 'terms_of_service')
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('site_settings')
      .select('*')
      .eq('key', 'privacy_policy')
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  return (
    <div>
      <div className="mb-10">
        <h1 className="display text-3xl">Legal Content</h1>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          Manage Terms of Service and Privacy Policy. Changes create new versions with audit
          trail.
        </p>
      </div>

      <div className="space-y-12 divide-y divide-[var(--color-border)]">
        <div>
          <LegalContentEditor
            setting={terms || null}
            settingKey="terms_of_service"
            label="Terms of Service"
          />
        </div>

        <div className="pt-12">
          <LegalContentEditor
            setting={privacy || null}
            settingKey="privacy_policy"
            label="Privacy Policy"
          />
        </div>
      </div>

      <div className="mt-12 border-t border-[var(--color-border)] pt-8">
        <h3 className="label-caps mb-4 text-[var(--color-accent)]">Version History</h3>
        <p className="text-sm text-[var(--color-muted)]">
          All versions are retained in the database for compliance. Users agree to the active
          version on signup, and the version number is recorded in their profile.
        </p>
      </div>
    </div>
  )
}
