import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ProfileSettings } from '@/components/shared/ProfileSettings'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: profile }, { data: record }] = await Promise.all([
    supabase
      .from('profiles')
      .select('first_name, last_name, email, phone, pronouns, date_of_birth, marketing_opt_in, sms_opt_in')
      .eq('id', user.id)
      .maybeSingle(),
    supabase
      .from('client_records')
      .select('photo_release_at, photo_release_revoked_at')
      .eq('client_id', user.id)
      .maybeSingle(),
  ])

  return (
    <div>
      <h1 className="display text-3xl">Settings</h1>
      <div className="mt-10 max-w-xl">
        <ProfileSettings
          userId={user.id}
          profile={{
            first_name: profile?.first_name ?? '',
            last_name: profile?.last_name ?? '',
            email: profile?.email ?? user.email ?? '',
            phone: profile?.phone ?? '',
            pronouns: profile?.pronouns ?? '',
            date_of_birth: profile?.date_of_birth ?? '',
            marketing_opt_in: profile?.marketing_opt_in ?? false,
            sms_opt_in: profile?.sms_opt_in ?? false,
          }}
          photoReleaseGiven={
            !!record?.photo_release_at && !record?.photo_release_revoked_at
          }
        />
      </div>
    </div>
  )
}
