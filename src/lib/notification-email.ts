import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { siteUrl } from '@/lib/stripe'

/**
 * The email mirror of the in-app bell (072).
 *
 * Every notification row is written exactly as before — by triggers, routes
 * and actions that neither know nor care about email. This module sweeps the
 * rows still owed an email (`emailed_at is null`) and sends each one through
 * Resend, then stamps it. Callers fire it after doing something that rings a
 * bell, and a daily cron sweeps whatever those pings missed — so delivery is
 * usually seconds behind the bell and never depends on any one caller.
 *
 * Unconfigured (no RESEND_API_KEY) it does nothing, silently: email is a
 * mirror, and the bell remains the record.
 */

const BATCH = 30
/** A row this old that still cannot send is abandoned rather than retried
 *  forever — the bell already told them, and stale email is worse than none. */
const GIVE_UP_MS = 3 * 24 * 60 * 60 * 1000

/** The sender, overridable by env. The default is at the studio's own domain,
 *  which is what the Resend account verifies. */
function emailFrom(): string {
  return process.env.EMAIL_FROM ?? '559 Flawless <hello@559flawless.com>'
}

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY)
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The one template: title, body, a button into the site. Inline styles only —
 *  email clients ignore everything else. */
function emailHtml(title: string, body: string | null, link: string | null): string {
  const origin = siteUrl()
  const href = `${origin}${link && link.startsWith('/') ? link : '/account'}`
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#faf7f5;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;font-family:Georgia,'Times New Roman',serif;color:#2b2320;">
    <p style="font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#a08573;margin:0 0 28px;">559 Flawless</p>
    <h1 style="font-size:26px;font-weight:normal;margin:0 0 16px;">${esc(title)}</h1>
    ${body ? `<p style="font-size:16px;line-height:1.6;color:#5c5049;margin:0 0 28px;font-family:Helvetica,Arial,sans-serif;">${esc(body)}</p>` : ''}
    <a href="${href}" style="display:inline-block;background:#2b2320;color:#faf7f5;text-decoration:none;padding:14px 28px;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;font-family:Helvetica,Arial,sans-serif;">Open in your account</a>
    <p style="font-size:12px;color:#a08573;margin:36px 0 0;font-family:Helvetica,Arial,sans-serif;">
      Sent by 559 Flawless because this account has notifications. You can read everything on the website too.
    </p>
  </div>
</body></html>`
}

/**
 * Email an invitation's claim link, from the studio.
 *
 * Separate from the notification mirror on purpose: an invitee has no account,
 * so there is no notification row to sweep and no bell as the fallback record —
 * this email IS the delivery. The caller keeps returning the link for staff to
 * copy, so a bounced or unconfigured send degrades to exactly the behaviour the
 * invite flow had before email existed.
 *
 * Returns whether Resend accepted it; never throws.
 */
export async function sendInvitationEmail(opts: {
  to: string
  firstName: string | null
  url: string
  expiresAt: string
  note?: string | null
}): Promise<boolean> {
  if (!emailConfigured()) return false

  const greeting = opts.firstName?.trim() ? `Hi ${opts.firstName.trim()} — ` : ''
  const expires = new Date(opts.expiresAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
  })

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#faf7f5;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;font-family:Georgia,'Times New Roman',serif;color:#2b2320;">
    <p style="font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#a08573;margin:0 0 28px;">559 Flawless</p>
    <h1 style="font-size:26px;font-weight:normal;margin:0 0 16px;">Your account is waiting</h1>
    <p style="font-size:16px;line-height:1.6;color:#5c5049;margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;">
      ${esc(greeting)}the studio set up an account for you at 559 Flawless. Claim it to see your
      appointments, sign forms ahead of your visit, and book online.
    </p>
    ${opts.note ? `<p style="font-size:15px;line-height:1.6;color:#5c5049;margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-style:italic;">&ldquo;${esc(opts.note)}&rdquo;</p>` : ''}
    <a href="${esc(opts.url)}" style="display:inline-block;background:#2b2320;color:#faf7f5;text-decoration:none;padding:14px 28px;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;font-family:Helvetica,Arial,sans-serif;">Claim your account</a>
    <p style="font-size:12px;color:#a08573;margin:36px 0 0;font-family:Helvetica,Arial,sans-serif;">
      This link is yours alone and expires on ${esc(expires)}. If you were not expecting this,
      you can ignore it — nothing happens without you.
    </p>
  </div>
</body></html>`

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: emailFrom(),
        to: opts.to,
        subject: 'Claim your 559 Flawless account',
        html,
      }),
    })
    if (!res.ok) {
      console.error('invitation email failed', res.status, await res.text().catch(() => ''))
    }
    return res.ok
  } catch (err) {
    console.error('invitation email failed', err)
    return false
  }
}

export interface DispatchResult {
  sent: number
  skipped: number
  failed: number
}

/**
 * Send every notification still owed an email, oldest first, one batch.
 * Safe to call from anywhere at any frequency — the `emailed_at` stamp is
 * the idempotency, and two concurrent sweeps at worst race to stamp the same
 * row (Resend sees a duplicate of one email, not a flood).
 */
export async function dispatchNotificationEmails(): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, skipped: 0, failed: 0 }
  if (!emailConfigured()) return result

  const admin = createAdminClient()

  const { data: pending } = await admin
    .from('notifications')
    .select('id, user_id, title, body, link, created_at')
    .is('emailed_at', null)
    .order('created_at')
    .limit(BATCH)

  if (!pending || pending.length === 0) return result

  const userIds = [...new Set(pending.map((n) => n.user_id))]
  const { data: profiles } = await admin
    .from('profiles')
    .select('id, email, suspended_at')
    .in('id', userIds)
  const profileFor = new Map((profiles ?? []).map((p) => [p.id, p]))

  const now = Date.now()

  for (const n of pending) {
    const profile = profileFor.get(n.user_id)
    const address = profile?.email?.trim()

    // Permanently unsendable — no address, or a suspended account. Stamp so
    // it never clogs the sweep; the bell has it either way.
    if (!address || profile?.suspended_at) {
      await admin.from('notifications').update({ emailed_at: new Date().toISOString() }).eq('id', n.id)
      result.skipped += 1
      continue
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: emailFrom(),
          to: address,
          subject: n.title,
          html: emailHtml(n.title, n.body, n.link),
        }),
      })

      if (res.ok) {
        await admin.from('notifications').update({ emailed_at: new Date().toISOString() }).eq('id', n.id)
        result.sent += 1
      } else if (now - new Date(n.created_at).getTime() > GIVE_UP_MS) {
        console.error('notification email abandoned', n.id, res.status, await res.text().catch(() => ''))
        await admin.from('notifications').update({ emailed_at: new Date().toISOString() }).eq('id', n.id)
        result.failed += 1
      } else {
        console.error('notification email failed', n.id, res.status, await res.text().catch(() => ''))
        result.failed += 1
      }
    } catch {
      result.failed += 1
    }
  }

  return result
}

/**
 * Fire-and-forget for server code that just rang a bell. Never awaited into a
 * response path, never allowed to throw into one.
 */
export function queueNotificationEmails(): void {
  if (!emailConfigured()) return
  void dispatchNotificationEmails().catch((err) =>
    console.error('notification email dispatch failed', err)
  )
}
