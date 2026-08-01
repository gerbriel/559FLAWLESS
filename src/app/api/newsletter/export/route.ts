import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isManager } from '@/types/database'

export const dynamic = 'force-dynamic'

/** RFC 4180 escaping: quote the field and double any quote inside it. */
function csvCell(value: string | null | undefined): string {
  const s = value ?? ''
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * The newsletter list as a CSV, for whichever mail tool the studio uses.
 *
 * Manager and above: this is the whole marketing list with email addresses, so
 * it is not something a front-desk login should be able to walk out with.
 */
export async function GET() {
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

  if (!profile || profile.suspended_at || !isManager(profile.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data: subscribers, error } = await supabase
    .from('newsletter_subscribers')
    .select('email, first_name, status, source, client_id, subscribed_at, unsubscribed_at')
    .order('subscribed_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: 'export_failed' }, { status: 500 })
  }

  const header = [
    'email',
    'first_name',
    'status',
    'source',
    'is_client',
    'subscribed_at',
    'unsubscribed_at',
  ]

  const lines = [
    header.join(','),
    ...(subscribers ?? []).map((s) =>
      [
        csvCell(s.email),
        csvCell(s.first_name),
        csvCell(s.status),
        csvCell(s.source),
        s.client_id ? 'yes' : 'no',
        csvCell(s.subscribed_at),
        csvCell(s.unsubscribed_at),
      ].join(',')
    ),
  ]

  // The BOM makes Excel read this as UTF-8 rather than mangling accented names.
  return new NextResponse(`﻿${lines.join('\r\n')}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="559flawless-newsletter.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
