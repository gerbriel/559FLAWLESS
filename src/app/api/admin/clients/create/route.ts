import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isFrontDesk } from '@/types/database'

export const dynamic = 'force-dynamic'

const NewClientSchema = z.object({
  // An account is the whole four. This route only ever creates one, so it asks
  // for all of them — the incomplete person belongs in `client_stubs` (051),
  // which is reachable from the importer and from the client's own record, and
  // becomes an account through an invitation rather than through here.
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(7).max(40),
  pronouns: z.string().trim().max(40).nullish(),
  date_of_birth: z.string().trim().max(10).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  marketing_opt_in: z.boolean().default(false),
})

/**
 * Create a client on their behalf — the walk-in and phone-booking case.
 *
 * A profile row is FK'd to auth.users, so a client record needs an auth user;
 * the `handle_new_user` trigger then creates the profile from the metadata
 * passed here. The account is made WITHOUT a password: the client can claim it
 * later with "email me a sign-in link", which avoids staff inventing a password
 * and reading it out to someone.
 *
 * Requires front desk or above. Uses the service-role client, so authorisation
 * is checked explicitly before anything is written.
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

  const parsed = NewClientSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'Please check the details and try again.' },
      { status: 400 }
    )
  }

  const body = parsed.data
  const email = body.email.toLowerCase()
  const admin = createAdminClient()

  // If this person already has an account, say so and point at them rather than
  // silently failing on the unique constraint.
  const { data: existing } = await admin
    .from('profiles')
    .select('id, first_name, last_name, role')
    .ilike('email', email)
    .maybeSingle()

  if (existing) {
    return NextResponse.json(
      {
        error: 'already_exists',
        message: (() => {
          // Built once rather than interpolated twice: a client with no surname
          // was reading "Yesenia null already has an account."
          const name = `${existing.first_name ?? ''} ${existing.last_name ?? ''}`.trim()
          return name
            ? `${name} already has an account.`
            : 'Someone already has an account with that email.'
        })(),
        clientId: existing.role === 'client' ? existing.id : null,
      },
      { status: 409 }
    )
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    // Confirmed on creation: the studio has verified this person in the room or
    // on the phone, and an unconfirmed account cannot receive a sign-in link.
    email_confirm: true,
    user_metadata: {
      first_name: body.first_name,
      last_name: body.last_name,
      phone: body.phone ?? null,
    },
  })

  if (createError || !created.user) {
    console.error('client account creation failed', createError)
    return NextResponse.json(
      { error: 'create_failed', message: 'Could not create that account.' },
      { status: 500 }
    )
  }

  const clientId = created.user.id

  // The handle_new_user trigger has already made the profile from the metadata;
  // fill in the rest and record who added them.
  const { error: profileError } = await admin
    .from('profiles')
    .update({
      role: 'client',
      email,
      phone: body.phone ?? null,
      pronouns: body.pronouns ?? null,
      date_of_birth: body.date_of_birth || null,
      marketing_opt_in: body.marketing_opt_in,
      marketing_consent_at: body.marketing_opt_in ? new Date().toISOString() : null,
      created_by_staff_id: user.id,
    })
    .eq('id', clientId)

  if (profileError) {
    // Roll the auth user back rather than leave an account with no profile.
    await admin.auth.admin.deleteUser(clientId)
    console.error('client profile update failed', profileError)
    return NextResponse.json(
      { error: 'create_failed', message: 'Could not create that account.' },
      { status: 500 }
    )
  }

  // Give them a client record straight away so the CRM has somewhere to hang
  // notes and stats before their first visit.
  await admin.from('client_records').upsert({ client_id: clientId }, { onConflict: 'client_id' })

  if (body.notes) {
    await admin.from('client_notes').insert({
      client_id: clientId,
      author_id: user.id,
      body: body.notes,
    })
  }

  await admin.rpc('log_user_activity', {
    p_user_id: clientId,
    p_action: 'client_created_by_staff',
    p_details: { email },
    p_performed_by: user.id,
  })

  return NextResponse.json({ ok: true, clientId }, { status: 201 })
}
