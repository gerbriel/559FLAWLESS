import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  syncAppointmentToCalendar,
  syncBlockToCalendar,
  removeBlockFromCalendar,
} from '@/lib/calendar-push'
import { isStaff } from '@/types/database'

export const dynamic = 'force-dynamic'

const PushSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('appointment'), id: z.string().uuid() }),
  z.object({ kind: z.literal('block'), id: z.number().int().positive() }),
  z.object({
    kind: z.literal('block_removed'),
    providerId: z.string().uuid(),
    googleEventId: z.string().min(1),
  }),
])

/**
 * Push one thing to Google, on demand.
 *
 * Client components cannot import the push helpers — they use the service-role
 * client and Node's crypto — so anything that changes an appointment or a block
 * from the browser calls this afterwards.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || profile.suspended_at || !isStaff(profile.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsed = PushSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  const body = parsed.data
  const admin = createAdminClient()

  if (body.kind === 'appointment') {
    await syncAppointmentToCalendar(body.id)
    return NextResponse.json({ ok: true })
  }

  if (body.kind === 'block') {
    // A block belongs to one provider's calendar. Anyone but that provider
    // writing to it would be putting entries in someone else's personal
    // calendar, so only they or an admin may trigger the push.
    const { data: block } = await admin
      .from('availability_blocks')
      .select('provider_id')
      .eq('id', body.id)
      .maybeSingle()

    if (!block) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (block.provider_id !== user.id && profile.role !== 'admin') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    await syncBlockToCalendar(body.id)
    return NextResponse.json({ ok: true })
  }

  if (body.providerId !== user.id && profile.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  await removeBlockFromCalendar(body.providerId, body.googleEventId)
  return NextResponse.json({ ok: true })
}
