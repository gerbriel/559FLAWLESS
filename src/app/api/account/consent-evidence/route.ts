import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const EvidenceSchema = z.object({
  marketing: z.boolean(),
  terms: z.boolean(),
})

/**
 * Record what a new account agreed to, with the evidence that makes it stand up.
 *
 * The IP is read from the request here rather than looked up in the browser.
 * The sign-up form previously called api.ipify.org from the client to find it,
 * which disclosed every new client's address to a third party — to capture a
 * field the server already had, on a request that must reach us anyway. That is
 * a privacy cost for no information gain, and it made sign-up depend on someone
 * else's uptime.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Only ever stamps the caller's own row, so an unauthenticated request has
  // nothing to write.
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const parsed = EvidenceSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  const { marketing, terms } = parsed.data

  // `x-forwarded-for` is a list; the client is the first entry. Behind Vercel
  // this is set by the platform. Null rather than a guess if it is absent —
  // a wrong IP in a consent record is worse than no IP.
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() || null
  const userAgent = request.headers.get('user-agent')

  const now = new Date().toISOString()
  const admin = createAdminClient()

  const { error } = await admin
    .from('profiles')
    .update({
      marketing_opt_in: marketing,
      ...(marketing ? { marketing_consent_at: now, marketing_consent_ip: ip } : {}),
      ...(terms
        ? { terms_accepted_at: now, terms_version_accepted: 1, privacy_accepted_at: now }
        : {}),
    })
    .eq('id', user.id)

  if (error) {
    console.error('consent evidence write failed', error)
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, ip_recorded: !!ip, user_agent: !!userAgent })
}
