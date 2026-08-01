'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

/**
 * The details a signed-in client should never be asked for twice.
 *
 * Name, email and phone are *identity*: they belong to the person, we already
 * hold them, and re-asking is only ever a chance to mistype. What they want to
 * talk about, which service, what to know before the visit — those are new
 * every time and stay on the form.
 *
 * Two things live here: the way we say who we think someone is, and the way a
 * detail they had to supply gets kept.
 */

const CONTACT_FIELDS = ['first_name', 'last_name', 'phone'] as const
type ContactField = (typeof CONTACT_FIELDS)[number]

/** What a form can hand back for keeping. Blanks are ignored, never written. */
export type SuppliedContact = Partial<Record<ContactField, string | null | undefined>>

/**
 * The signed-in viewer's email, resolved in the browser.
 *
 * For components that render inside the public layout, which deliberately never
 * reads a cookie: doing so server-side would opt every marketing page out of
 * static rendering for the sake of one prefill. `getSession()` reads what is
 * already in the browser rather than calling out, so the common anonymous case
 * costs nothing and resolves in the same tick.
 *
 * Components with a server parent that is already dynamic should take the
 * profile as props instead — it arrives with the first paint and covers the
 * name and phone too.
 */
export function useSignedInEmail(): { email: string | null; resolved: boolean } {
  const [state, setState] = useState<{ email: string | null; resolved: boolean }>({
    email: null,
    resolved: false,
  })

  useEffect(() => {
    let alive = true

    async function resolve() {
      const supabase = createClient()
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (alive) setState({ email: session?.user.email ?? null, resolved: true })
    }

    // A failure here means "we do not know who this is", which is exactly the
    // anonymous case — the form still works, it just asks.
    void resolve().catch(() => {
      if (alive) setState({ email: null, resolved: true })
    })

    return () => {
      alive = false
    }
  }, [])

  return state
}

/**
 * "Booking as Ana Ruiz · ana@… — Not you?"
 *
 * Shown in place of the fields it replaces, so nothing is hidden without being
 * said. The correction is a real control, not a hint: either a link somewhere
 * they can fix it, or a button that puts the field back.
 */
/**
 * The signed-in viewer's contact details, resolved in the browser.
 *
 * For surfaces on statically-rendered pages — the bag, the footer — where a
 * server-side session read would turn the whole subtree dynamic. Everything
 * here is convenience: what the server writes is decided from the session on
 * the request, never from this.
 */
export function useSignedInContact(): {
  userId: string | null
  email: string | null
  firstName: string | null
  lastName: string | null
  phone: string | null
  resolved: boolean
} {
  const [state, setState] = useState({
    userId: null as string | null,
    email: null as string | null,
    firstName: null as string | null,
    lastName: null as string | null,
    phone: null as string | null,
    resolved: false,
  })

  useEffect(() => {
    let alive = true

    async function resolve() {
      const supabase = createClient()
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.user) {
        if (alive) setState((s) => ({ ...s, resolved: true }))
        return
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('first_name, last_name, phone, email')
        .eq('id', session.user.id)
        .maybeSingle()

      if (!alive) return
      setState({
        userId: session.user.id,
        email: profile?.email ?? session.user.email ?? null,
        firstName: profile?.first_name ?? null,
        lastName: profile?.last_name ?? null,
        phone: profile?.phone ?? null,
        resolved: true,
      })
    }

    void resolve().catch(() => {
      if (alive) setState((s) => ({ ...s, resolved: true }))
    })

    return () => {
      alive = false
    }
  }, [])

  return state
}

export function SignedInAs({
  label,
  name,
  email,
  changeLabel = 'Not you?',
  href,
  onChange,
  className,
}: {
  label: string
  name?: string | null
  email?: string | null
  /** Where to go to correct it. Ignored when `onChange` is given. */
  href?: string
  /** Put the field back instead of navigating away. */
  onChange?: () => void
  changeLabel?: string
  className?: string
}) {
  const who = name?.trim() || email || ''
  const showEmail = !!email && !!name?.trim()

  // min-h-11 is the 44px tap target on touch; the surrounding text is dense on
  // a pointer device, where the target does not need padding out.
  const control =
    'inline-flex min-h-11 items-center underline underline-offset-4 hover:text-[var(--color-accent)] sm:min-h-0'

  return (
    <p className={cn('text-sm text-[var(--color-muted)]', className)}>
      {label} <span className="text-[var(--color-foreground)]">{who}</span>
      {showEmail && <> · <span className="break-all">{email}</span></>}{' '}
      {onChange ? (
        <button type="button" onClick={onChange} className={control}>
          {changeLabel}
        </button>
      ) : (
        <Link href={href ?? '/account/settings'} className={control}>
          {changeLabel}
        </Link>
      )}
    </p>
  )
}

/**
 * Keep a detail the client just supplied because we did not have it.
 *
 * This is what makes "asked once" true — a phone number typed into the booking
 * form is on the profile before the next form renders. A value already on the
 * profile is never touched: the current row is re-read rather than trusting
 * what the page was rendered with, so a number set in another tab (or by the
 * front desk) is not overwritten by a form that loaded before it existed.
 *
 * Housekeeping, not the user's action. A failure is silent — the booking or the
 * message it followed already succeeded, and there is nothing to ask them to do.
 */
export async function backfillProfile(userId: string, supplied: SuppliedContact): Promise<void> {
  const offered = CONTACT_FIELDS.filter((f) => supplied[f]?.trim())
  if (offered.length === 0) return

  try {
    const supabase = createClient()
    const { data: current } = await supabase
      .from('profiles')
      .select('first_name, last_name, phone')
      .eq('id', userId)
      .maybeSingle()

    if (!current) return

    const patch: Partial<Record<ContactField, string>> = {}
    for (const field of offered) {
      const held = current[field]
      if (held == null || held.trim() === '') patch[field] = supplied[field]!.trim()
    }

    if (Object.keys(patch).length === 0) return
    await supabase.from('profiles').update(patch).eq('id', userId)
  } catch {
    // Deliberately swallowed — see above.
  }
}
