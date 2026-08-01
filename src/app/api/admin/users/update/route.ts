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
    const { userId, updates } = await request.json()

    if (!userId || !updates) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Validate that we're not removing the last admin
    if (updates.role && updates.role !== 'admin') {
      const { data: currentUser } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle()

      if (currentUser?.role === 'admin') {
        const { count } = await supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'admin')
          .is('suspended_at', null)

        if (count === 1) {
          return NextResponse.json(
            { error: 'Cannot remove or demote the last admin' },
            { status: 400 }
          )
        }
      }
    }

    // Use admin client to update (RLS is respected, but we have admin access)
    const adminClient = createAdminClient()
    const { error: updateError } = await adminClient
      .from('profiles')
      .update(updates)
      .eq('id', userId)

    if (updateError) {
      console.error('Error updating user:', updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    // Log the activity
    await adminClient.rpc('log_user_activity', {
      p_user_id: userId,
      p_action: 'profile_updated_by_admin',
      p_details: { updated_fields: Object.keys(updates), updates },
      p_performed_by: user.id,
    })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Error in user update:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
