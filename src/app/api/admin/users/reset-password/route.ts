import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAdmin } from '@/types/database'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Check authentication
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check authorization
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile || !isAdmin(profile.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Parse request
    const { email } = await request.json()

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    // Use admin client to send password reset
    const adminClient = createAdminClient()
    const { error } = await adminClient.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/account/settings`,
    })

    if (error) {
      console.error('Error sending password reset:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Log the activity
    const { data: targetUser } = await adminClient
      .from('profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle()

    if (targetUser) {
      await adminClient.rpc('log_user_activity', {
        p_user_id: targetUser.id,
        p_action: 'password_reset_requested_by_admin',
        p_details: { initiated_by: user.id },
        p_performed_by: user.id,
      })
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Error in password reset:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
