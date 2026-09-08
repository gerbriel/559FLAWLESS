import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isFrontDesk } from '@/types/database'

export const dynamic = 'force-dynamic'

const UpdateSchema = z.object({
  clientId: z.string().uuid(),
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().max(80).nullish(),
  // Empty means "leave the login email alone" — an auth account cannot have no
  // address, so there is no clearing it, only changing it.
  email: z.union([z.literal(''), z.string().trim().email().max(254)]).nullish(),
  phone: z.string().trim().max(40).nullish(),
  pronouns: z.string().trim().max(40).nullish(),
  date_of_birth: z
    .union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])
    .nullish(),
})

/**
 * Staff corrections to a client's own details — the misspelled name from the
 * phone, the number that changed, the email typo'd at the desk.
 *
 * A route rather than an RLS grant on purpose: 001 gives profile updates to
 * the owner and to admins, and widening that policy would hand front desk the
 * whole row — role, suspension, marketing consent. This touches exactly the
 * contact fields and nothing else, checks the caller explicitly, and keeps the
 * login email in step with the profile email through the auth admin API, which
 * no RLS policy can reach anyway.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: staff } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!staff || staff.suspended_at || !isFrontDesk(staff.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsed = UpdateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'Please check the details and try again.' },
      { status: 400 }
    )
  }

  const body = parsed.data
  const admin = createAdminClient()

  // Only clients. Staff details have their own screen with its own rules.
  const { data: target } = await admin
    .from('profiles')
    .select('id, role, email')
    .eq('id', body.clientId)
    .maybeSingle()

  if (!target || target.role !== 'client') {
    return NextResponse.json({ error: 'unknown_client' }, { status: 404 })
  }

  const newEmail = body.email?.trim().toLowerCase() || null
  const emailChanged = !!newEmail && newEmail !== (target.email ?? '').toLowerCase()

  if (emailChanged) {
    const { data: taken } = await admin
      .from('profiles')
      .select('id, first_name, last_name')
      .ilike('email', newEmail!)
      .neq('id', target.id)
      .maybeSingle()

    if (taken) {
      const name = `${taken.first_name ?? ''} ${taken.last_name ?? ''}`.trim()
      return NextResponse.json(
        {
          error: 'email_taken',
          message: name
            ? `${name} already has that email. If they are the same person, merge the accounts instead.`
            : 'Another account already has that email.',
        },
        { status: 409 }
      )
    }

    // The login email moves first: if auth refuses, the profile has not
    // half-changed. Confirmed on the spot — the studio verified this person.
    const { error: authError } = await admin.auth.admin.updateUserById(target.id, {
      email: newEmail!,
      email_confirm: true,
    })
    if (authError) {
      console.error('client email change failed at auth', authError)
      return NextResponse.json(
        { error: 'update_failed', message: 'Could not change the sign-in email.' },
        { status: 500 }
      )
    }
  }

  const { error: profileError } = await admin
    .from('profiles')
    .update({
      first_name: body.first_name,
      last_name: body.last_name?.trim() || null,
      ...(emailChanged ? { email: newEmail } : {}),
      phone: body.phone?.trim() || null,
      pronouns: body.pronouns?.trim() || null,
      date_of_birth: body.date_of_birth || null,
    })
    .eq('id', target.id)

  if (profileError) {
    console.error('client profile update failed', profileError)
    return NextResponse.json(
      { error: 'update_failed', message: 'Could not save those details.' },
      { status: 500 }
    )
  }

  await admin.rpc('log_user_activity', {
    p_user_id: target.id,
    p_action: 'client_updated_by_staff',
    p_details: { email_changed: emailChanged },
    p_performed_by: user.id,
  })

  return NextResponse.json({ ok: true })
}
