import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getStripe, stripeConfigured, siteUrl } from '@/lib/stripe'
import { isAdmin, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * Is Stripe actually wired up?
 *
 * Every other answer to that question is indirect: a client reaches checkout,
 * something fails, and the studio finds out from somebody who wanted to pay.
 * This asks Stripe directly and reports what it says.
 *
 * IT NEVER RETURNS KEY MATERIAL. Only whether a key is present, which mode it
 * is in — `sk_test_` and `sk_live_` prefixes say that without revealing the
 * rest — and what Stripe reports about the account. Admin only, and a GET with
 * no side effects: it reads, it does not create a session or a charge.
 *
 * The webhook is the one thing this cannot fully verify. Stripe will not tell
 * an API caller which endpoints are registered against an account's signing
 * secrets, so the most it can do is confirm a secret is configured here and
 * hand back the exact URL that needs registering there. Sending a test event
 * from the Stripe dashboard is what closes that loop.
 */

/** Test or live, read from the key prefix alone. */
function modeOf(key: string | undefined): 'test' | 'live' | 'unknown' {
  if (!key) return 'unknown'
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test'
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live'
  return 'unknown'
}

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

  if (!profile || profile.suspended_at || !isAdmin(profile.role as UserRole)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const secret = process.env.STRIPE_SECRET_KEY
  const mode = modeOf(secret)

  const checks: { name: string; ok: boolean; detail: string }[] = []

  checks.push({
    name: 'STRIPE_SECRET_KEY',
    ok: Boolean(secret),
    detail: secret
      ? `Present, ${mode} mode.`
      : 'Missing. Checkout and deposits refuse politely until it is set.',
  })

  checks.push({
    name: 'STRIPE_WEBHOOK_SECRET',
    ok: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    detail: process.env.STRIPE_WEBHOOK_SECRET
      ? 'Present. Signatures will be verified.'
      : 'Missing. The webhook rejects every delivery, so payments would be taken and never recorded.',
  })

  // The one that quietly ruins a launch: a session minted with a success_url
  // pointing at localhost takes the money and lands the client nowhere.
  let site = ''
  let siteOk = false
  try {
    site = siteUrl()
    siteOk = site.startsWith('https://')
  } catch (err) {
    site = err instanceof Error ? err.message : 'unresolved'
  }
  checks.push({
    name: 'NEXT_PUBLIC_SITE_URL',
    ok: siteOk,
    detail: siteOk
      ? `${site} — where clients are returned after paying.`
      : `Not a public https address (${site}). Clients would be sent somewhere they cannot reach.`,
  })

  // Does the key actually work, and can the account take money today?
  let account: {
    ok: boolean
    detail: string
    business?: string | null
    charges_enabled?: boolean
    payouts_enabled?: boolean
  } = { ok: false, detail: 'Not checked — no secret key.' }

  if (stripeConfigured()) {
    try {
      // The SDK wants an explicit id even for "the account these keys belong
      // to"; 'account' is the alias Stripe accepts for exactly that.
      const acct = await getStripe().accounts.retrieve('account')
      const enabled = acct.charges_enabled === true
      account = {
        ok: enabled,
        detail: enabled
          ? 'Stripe accepted the key and the account can take payments.'
          : 'Stripe accepted the key, but this account cannot take payments yet — finish onboarding in the Stripe dashboard.',
        business: acct.business_profile?.name ?? acct.settings?.dashboard?.display_name ?? null,
        charges_enabled: acct.charges_enabled,
        payouts_enabled: acct.payouts_enabled,
      }
    } catch (err) {
      account = {
        ok: false,
        detail: `Stripe rejected the key: ${err instanceof Error ? err.message : 'unknown error'}`,
      }
    }
  }
  checks.push({ name: 'Stripe account', ...account })

  return NextResponse.json({
    ready: checks.every((c) => c.ok),
    mode,
    // Live keys on a site that has never taken a test payment is the ordering
    // worth flagging, not preventing.
    warning:
      mode === 'live'
        ? 'These are LIVE keys. Real cards will be charged.'
        : mode === 'test'
          ? 'Test mode. Use card 4242 4242 4242 4242 with any future expiry and any CVC.'
          : null,
    checks,
    webhook: {
      // Registered by hand in the Stripe dashboard; nothing here can do it.
      url: siteOk ? `${site}/api/stripe/webhook` : '(set NEXT_PUBLIC_SITE_URL first)',
      events: ['checkout.session.completed', 'checkout.session.expired', 'charge.refunded'],
      note: 'Add exactly these three in Stripe → Developers → Webhooks, then copy that endpoint’s signing secret into STRIPE_WEBHOOK_SECRET. Stripe cannot tell this route which endpoints exist, so send a test event to confirm.',
    },
    account: {
      business: account.business ?? null,
      charges_enabled: account.charges_enabled ?? null,
      payouts_enabled: account.payouts_enabled ?? null,
    },
  })
}
