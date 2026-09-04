import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { dispatchNotificationEmails, emailConfigured } from '@/lib/notification-email'

export const dynamic = 'force-dynamic'

/**
 * Flush the email mirror (072).
 *
 * GET is the daily cron sweeper (vercel.json), authenticated the same way the
 * templated dispatcher is: CRON_SECRET as a bearer token. POST is the
 * opportunistic ping — any signed-in user's browser fires it after an action
 * that rang a bell, which is what keeps email seconds behind the bell on a
 * plan whose crons only run daily. Safe at any frequency from anyone signed
 * in: it can only deliver what is already owed, to its owner.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ ok: true, ...(await dispatchNotificationEmails()) })
}

export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!emailConfigured()) return NextResponse.json({ ok: true, sent: 0, configured: false })

  return NextResponse.json({ ok: true, ...(await dispatchNotificationEmails()) })
}
