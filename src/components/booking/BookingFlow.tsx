'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Check, ChevronLeft, ChevronRight, Clock, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Textarea } from '@/components/ui/field'
import { cn, formatMoney, formatDuration } from '@/lib/utils'
import {
  addDaysToDateKey,
  dateKeyInTimeZone,
  formatTimeInTimeZone,
  timeZoneAbbreviation,
} from '@/lib/time'
import { trackEvent } from '@/components/shared/AnalyticsTracker'
import { clearConsidered, rememberConsidered } from '@/lib/interest'
import { FormRequirementChecker } from '@/components/shared/FormRequirementChecker'
import { DepositRedirect } from '@/components/shared/DepositRedirect'
import { MetaPixelEvent } from '@/components/shared/MetaPixelEvent'
import { WaitlistJoin } from '@/components/booking/WaitlistJoin'
import { SignedInAs, backfillProfile } from '@/components/shared/SignedInIdentity'

export interface BookableService {
  id: number
  category_id: number
  name: string
  slug: string
  description: string | null
  price_cents: number
  duration_minutes: number
  deposit_cents: number
  is_intimate: boolean
  requires_age_verification: boolean
  min_age: number
  patch_test_hours: number
  category: { name: string; slug: string; is_intimate: boolean }
  addons: { id: number; name: string; price_cents: number; duration_minutes: number }[]
}

export interface BookableProvider {
  id: string
  display_name: string
  bio: string | null
  timezone: string
  service_ids: number[]
}

interface DayResult {
  date: string
  slots: string[]
}

type Step = 'service' | 'provider' | 'time' | 'details' | 'done'

const STEPS: { key: Step; label: string }[] = [
  { key: 'service', label: 'Service' },
  { key: 'provider', label: 'Provider' },
  { key: 'time', label: 'Time' },
  { key: 'details', label: 'Details' },
]

const WEEK_DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export function BookingFlow({
  services,
  providers,
  initialServiceSlug,
  signedInUserId,
  signedInEmail,
  signedInName,
  signedInPhone,
}: {
  services: BookableService[]
  providers: BookableProvider[]
  initialServiceSlug?: string
  /** Present when the profile can be written back to — see `submit`. */
  signedInUserId?: string | null
  signedInEmail?: string | null
  signedInName?: { first: string; last: string } | null
  signedInPhone?: string | null
}) {
  const router = useRouter()

  // Deep link from a service page (/book?service=brazilian-wax) is resolved in
  // the initializers, not an effect: it is the starting state, not a reaction
  // to something changing, and doing it in an effect renders the wrong step
  // first and then corrects it.
  const deepLinked = initialServiceSlug
    ? (services.find((s) => s.slug === initialServiceSlug) ?? null)
    : null

  const [step, setStep] = useState<Step>(
    // An age-gated service still has to show its gate, so stay on step one.
    deepLinked && !deepLinked.requires_age_verification ? 'provider' : 'service'
  )
  // A visit can be several services — a facial and a wax booked as one
  // appointment occupying one continuous block, not two bookings side by side.
  const [selected, setSelected] = useState<BookableService[]>(deepLinked ? [deepLinked] : [])
  const [addonIds, setAddonIds] = useState<number[]>([])
  const [provider, setProvider] = useState<BookableProvider | null>(null)
  const [ageConfirmed, setAgeConfirmed] = useState(false)

  const [weekStart, setWeekStart] = useState<string | null>(null)
  // null is an OUTAGE, [] is an empty week — the difference between "the
  // calendar did not answer" and "fully booked", which must never look alike.
  const [days, setDays] = useState<DayResult[] | null>([])
  const [timezone, setTimezone] = useState('America/Los_Angeles')
  const [loadingSlots, setLoadingSlots] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null)

  const [form, setForm] = useState({
    first_name: signedInName?.first ?? '',
    last_name: signedInName?.last ?? '',
    email: signedInEmail ?? '',
    phone: signedInPhone ?? '',
    notes: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{
    id: string
    startsAt: string
    /**
     * What the database made of it, not what was asked for. Approval routing
     * lives in triggers (036), so an online booking can land as `pending` even
     * though the request asked to confirm it — and the client is told which.
     */
    status: string
    depositCents: number
    totalCents: number
  } | null>(null)
  /**
   * Set when the automatic hop to Stripe did not happen and the client has to
   * be given the tap instead. `submit` turns it on for a checkout session that
   * would not open; a booking held for review never tries in the first place.
   */
  const [checkoutBlocked, setCheckoutBlocked] = useState(false)

  const hasSelection = selected.length > 0

  // Only providers who offer EVERY chosen service. Booking a facial and a wax
  // with someone who only does one of them is not a bookable appointment.
  const eligibleProviders = useMemo(
    () =>
      hasSelection
        ? providers.filter((p) => selected.every((s) => p.service_ids.includes(s.id)))
        : [],
    [providers, selected, hasSelection]
  )

  // Add-ons offered by any chosen service, de-duplicated.
  const availableAddons = useMemo(() => {
    const byId = new Map<number, BookableService['addons'][number]>()
    for (const s of selected) for (const a of s.addons) byId.set(a.id, a)
    return [...byId.values()]
  }, [selected])

  const selectedAddons = useMemo(
    () => availableAddons.filter((a) => addonIds.includes(a.id)),
    [availableAddons, addonIds]
  )

  const totalCents =
    selected.reduce((n, s) => n + s.price_cents, 0) +
    selectedAddons.reduce((n, a) => n + a.price_cents, 0)
  const totalMinutes =
    selected.reduce((n, s) => n + s.duration_minutes, 0) +
    selectedAddons.reduce((n, a) => n + a.duration_minutes, 0)

  // The strictest service sets the rule for the whole visit.
  const requiresAge = selected.some((s) => s.requires_age_verification)
  const minAge = Math.max(0, ...selected.map((s) => s.min_age))
  const patchTestHours = Math.max(0, ...selected.map((s) => s.patch_test_hours))
  const depositCents = selected.reduce((n, s) => n + s.deposit_cents, 0)

  const ageGateSatisfied = !requiresAge || ageConfirmed

  // ── What we already know about them ──────────────────────
  // Booking requires an account, so the details step asks only for what the
  // profile does not already hold. Every one of these is identity — it belongs
  // to the person, not to this booking — so once it is on file we show it back
  // rather than asking again. The notes field is the opposite: new every visit.
  const signedIn = !!signedInEmail
  const askFirst = !signedIn || !signedInName?.first?.trim()
  // The booking API requires a last name, so a profile without one still has to
  // be asked — once, and then it is kept.
  const askLast = !signedIn || !signedInName?.last?.trim()
  const askEmail = !signedIn
  const askPhone = !signedIn || !signedInPhone?.trim()
  const askedCount = [askFirst, askLast, askEmail, askPhone].filter(Boolean).length
  // A lone field in a two-column grid reads as a mistake; let it span.
  const soloSpan = askedCount === 1 ? 'sm:col-span-2' : undefined

  /** Add or remove a service, keeping selection order. */
  function toggleService(s: BookableService) {
    setSelected((cur) => {
      const next = cur.some((x) => x.id === s.id)
        ? cur.filter((x) => x.id !== s.id)
        : [...cur, s]

      // A provider or add-on chosen for the old set may not apply to the new
      // one, so both are cleared rather than silently carried into an
      // impossible booking.
      setProvider(null)
      setSelectedSlot(null)
      setAddonIds((ids) => {
        const stillOffered = new Set(next.flatMap((x) => x.addons.map((a) => a.id)))
        return ids.filter((id) => stillOffered.has(id))
      })
      return next
    })
  }

  // ── Slot loading ─────────────────────────────────────────
  // The spinner is turned ON by whichever interaction starts a load (choosing a
  // provider, stepping the week) and turned OFF here when the data lands. That
  // keeps the effect a pure fetch with no synchronous setState of its own.
  const loadSlots = useCallback(
    async (from: string) => {
      if (!hasSelection || !provider) return
      try {
        const qs = new URLSearchParams({
          provider: provider.id,
          service: selected.map((x) => x.id).join(','),
          from,
          days: '7',
        })
        if (addonIds.length) qs.set('addons', addonIds.join(','))

        // `.catch(() => null)`: a network failure must land as the outage
        // panel, not escape as an unhandled rejection leaving stale slots.
        const res = await fetch(`/api/availability?${qs}`).catch(() => null)
        if (!res || !res.ok) {
          // null is the outage signal — never an empty week. See `days`.
          setDays(null)
          return
        }
        const data = await res.json().catch(() => null)
        setDays(data ? (data.days ?? []) : null)
        if (data) setTimezone(data.timezone ?? provider.timezone)
      } finally {
        setLoadingSlots(false)
      }
    },
    // The whole of `selected`, not just its first entry. Keying this on
    // selected[0] left the callback un-recreated when a SECOND service was
    // added, holding a stale closure — slots were then fetched for the first
    // service's duration alone, and a client booking a facial plus a wax could
    // take a slot too short for both.
    [selected, hasSelection, provider, addonIds]
  )

  // The effect only fetches. `weekStart` is seeded when a provider is picked,
  // in that event handler, so this never has to set state to correct itself.
  useEffect(() => {
    if (step !== 'time' || !provider || !weekStart) return
    void loadSlots(weekStart)
  }, [step, provider, weekStart, loadSlots])

  // ── Submit ───────────────────────────────────────────────
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!hasSelection || !provider || !selectedSlot) return

    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: provider.id,
          service_ids: selected.map((x) => x.id),
          addon_ids: addonIds,
          starts_at: selectedSlot,
          first_name: form.first_name,
          last_name: form.last_name,
          email: form.email,
          phone: form.phone || null,
          notes: form.notes || null,
          age_attested: ageConfirmed,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        // The limiter's refusal has no message field — give it a human one
        // rather than the generic fallback, since the fix is simply waiting.
        if (data.error === 'rate_limited') {
          setError('That is a lot of bookings from one place in a short time. Give it a few minutes and try again.')
          return
        }
        setError(data.message ?? 'Something went wrong. Please try again.')
        // The slot went stale mid-flow — refresh what's on offer.
        if (data.error === 'slot_taken' || data.error === 'slot_unavailable') {
          setSelectedSlot(null)
          setStep('time')
          if (weekStart) void loadSlots(weekStart)
        }
        return
      }

      void trackEvent('booking_completed', {
        service_ids: selected.map((x) => x.id),
        provider_id: provider.id,
      })
      // A booked service is not a pending thought — drop the home page note.
      clearConsidered()

      // An older server build that does not send this is treated as the status
      // the studio has run on until now.
      const status: string = data.booking.status ?? 'confirmed'
      const heldForReview = status === 'pending'

      setConfirmation({
        id: data.booking.id,
        startsAt: data.booking.startsAt,
        status,
        depositCents: data.booking.depositCents,
        totalCents: data.booking.totalCents,
      })
      setStep('done')

      // A detail they had to type because the profile lacked it is kept, so the
      // next form does not ask for it. Awaited rather than fired off: the
      // deposit redirect below navigates away, and an in-flight request would
      // be cancelled with it.
      if (signedInUserId) {
        await backfillProfile(signedInUserId, {
          first_name: askFirst ? form.first_name : undefined,
          last_name: askLast ? form.last_name : undefined,
          phone: askPhone ? form.phone : undefined,
        })
      }

      /**
       * A booking the studio still has to approve is NOT thrown at Stripe.
       *
       * `window.location.assign` leaves before a browser has painted anything
       * worth reading, so the screen below — the one that says this is not
       * confirmed yet — existed only for bookings without a deposit. The client
       * paying money was the single client who never got told, and they came
       * back from Stripe with a receipt believing they had an appointment.
       *
       * So: it still comes to checkout, because a held slot is exactly what a
       * deposit is for, but by a tap on a screen that has said what it is first.
       * `heldForReview` is what the database made of the booking (036), not what
       * was asked for.
       */
      if (data.booking.depositCents > 0 && !heldForReview) {
        // Confirmed and paying: straight through, as before.
        const checkout = await fetch('/api/stripe/deposit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appointment_id: data.booking.id }),
        })
        const checkoutData = await checkout.json().catch(() => null)
        if (checkout.ok && checkoutData?.url) {
          window.location.assign(checkoutData.url)
          return
        }
        // Checkout would not open. Say so and offer the tap — the alternative
        // was "Taking you to secure checkout" sitting on screen for ever while
        // nothing happened.
        setCheckoutBlocked(true)
      }

      router.refresh()
    } catch {
      setError('We could not reach the booking service. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Confirmation ─────────────────────────────────────────
  if (step === 'done' && confirmation) {
    /**
     * The database, not this component, decides whether a booking is confirmed:
     * appointment_route_approval (036) holds an online booking for review when a
     * rule says so, and `status` on the response is what it landed as.
     *
     * This is the one screen where getting that wrong is unrecoverable — the
     * client reads "confirmed" here and "Awaiting confirmation" on
     * /account/appointments, and only one of them can be true.
     */
    const heldForReview = confirmation.status === 'pending'

    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        {/* The conversion, for ads. Fires here for bookings that stay on this
            screen; a deposit booking that leaves for Stripe fires the same id
            again on the appointment page it returns to, and the two dedupe.
            A held-for-review booking still counts — the client completed the
            form; approval is the studio's step, not theirs. */}
        <MetaPixelEvent
          event="CompleteRegistration"
          id={`booking-${confirmation.id}`}
          value={confirmation.totalCents / 100}
        />
        <div className="mx-auto flex h-14 w-14 items-center justify-center border border-[var(--color-accent)]">
          {heldForReview ? (
            <Clock className="h-6 w-6 text-[var(--color-accent)]" strokeWidth={1.5} />
          ) : (
            <Check className="h-6 w-6 text-[var(--color-accent)]" strokeWidth={1.5} />
          )}
        </div>
        <h2 className="display mt-8 text-4xl">
          {heldForReview ? 'Your time is held.' : <>You&rsquo;re booked.</>}
        </h2>
        {/* Every service that was booked, joined the way the approval queue
            joins them. Naming only the first one described a three-service visit
            as a single wax — the same class of untruth as calling a pending
            booking confirmed, and on the one screen nobody comes back to. */}
        <p className="mt-4 text-[var(--color-muted)]">
          {selected.map((s) => s.name).join(' + ')} with {provider?.display_name}
        </p>
        <p className="mt-1 text-lg">
          {formatDateTime(confirmation.startsAt, timezone)}{' '}
          <span className="text-sm text-[var(--color-muted)]">
            {timeZoneAbbreviation(new Date(confirmation.startsAt), timezone)}
          </span>
        </p>

        {/*
          Every claim here is one the code keeps. The slot really is reserved —
          the exclusion constraint covers everything that is not cancelled, so a
          pending appointment holds its time exactly as a confirmed one does, and
          declining it is what releases it. The notification on approval is
          written by appointment_notify_review (049) and it is keyed to
          client_id, so it only reaches someone with an account; a guest is
          promised contact by a person, which is all the studio can actually do
          — there is no mail or SMS sender in this codebase, so "notification"
          here means the bell in the account header and nothing else. That bell
          is mounted in src/app/account/layout.tsx; if it is ever removed, this
          sentence goes back to being a promise the app cannot keep.
        */}
        {heldForReview && (
          <p className="mt-8 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-5 text-left text-sm leading-relaxed text-[var(--color-muted)] dark:bg-[var(--color-surface)]">
            This one is not confirmed yet. The studio looks at some website bookings
            before confirming them and this is one of them. Your time stays reserved
            on the calendar while that happens — nobody else can take it.{' '}
            {signedIn
              ? 'You will get a notification in your account as soon as it is confirmed. Until then it shows as awaiting confirmation on your appointments page.'
              : 'We will call or email you as soon as it is confirmed.'}
          </p>
        )}

        {/*
          The deposit.

          /api/stripe/deposit takes any appointment that is not cancelled, so a
          booking held for review does come to checkout — but it gets here by a
          tap, not by `submit` redirecting out from under the copy above. See the
          comment on that branch for why.

          What is promised here is deliberate and it is not enforced by any code:
          if the studio declines, the deposit comes back in full. There is no
          automatic refund in this app — the only thing that ever marks a deposit
          refunded is the charge.refunded webhook reacting to a human — so the
          matching obligation is put in front of that human instead:
          PendingBookingActions makes whoever declines a paid booking tick a box
          saying they will issue the refund themselves, and tells them where.
          These two pieces of copy are a pair. Change one, change the other.
        */}
        {confirmation.depositCents > 0 &&
          (heldForReview || checkoutBlocked ? (
            <div className="mt-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-left">
              <p className="label-caps text-[var(--color-accent)]">
                Deposit · {formatMoney(confirmation.depositCents)}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
                {heldForReview ? (
                  <>
                    This is not payment for a confirmed appointment. Your time is
                    already held while the studio reviews the booking, so paying is
                    not what reserves it — the studio asks for the deposit up front
                    and it comes off your total on the day. If we cannot take this
                    booking, it is returned to you in full.
                  </>
                ) : (
                  <>
                    We could not open secure checkout just now. Your appointment is
                    booked — it is only the payment that did not start. The deposit
                    comes off your total on the day.
                  </>
                )}
              </p>
              <div className="mt-5">
                <DepositRedirect appointmentId={confirmation.id} />
              </div>
              {signedIn && (
                <p className="mt-3 text-xs text-[var(--color-muted)]">
                  You can also pay it later from your appointments page.
                </p>
              )}
            </div>
          ) : (
            <p className="mt-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-muted)]">
              Taking you to secure checkout to pay the{' '}
              {formatMoney(confirmation.depositCents)} deposit. Your slot is held
              until then.
            </p>
          ))}

        {/*
          The paperwork comes after the slot is secured, not in front of it.
          Requiring two clinical forms before the Confirm button meant someone who
          came to reserve a time left without one. The forms are still required
          before treatment — this is a prompt with a deadline, not an optional extra.

          When the booking is held for review the prompt stays and only the reason
          changes. The review itself reads no form status — PendingBookingActions
          writes the status and nothing else, and the queue does not query intake
          or consent — so the copy must not sell these as what unlocks the
          confirmation. The honest pitch is the waiting period itself.

          Every service goes in, not just the first. The consent a booking owes
          is the union over everything on it — an intimate-services form
          attached to the second service was never put in front of the client,
          while the provider's card went on showing it outstanding.
        */}
        {hasSelection && (
          <div className="mt-10 text-left">
            <FormRequirementChecker
              serviceIds={selected.map((s) => s.id)}
              categoryIds={selected.map((s) => s.category_id)}
              returnTo="/account/appointments"
              heading={heldForReview ? 'While you wait' : 'One more thing'}
              intro={
                heldForReview
                  ? 'Your booking is with the studio to confirm. Now is the time to fill these in — we need them before we can treat you either way, and it means nothing is left outstanding on your side by the time it is confirmed.'
                  : 'Your appointment is confirmed. Please fill these in before your visit — it saves time in the room, and we need them to treat you.'
              }
            />
          </div>
        )}

        <div className="mt-10 flex justify-center gap-4">
          <Link href="/account/appointments" className="label-caps border-b border-[var(--color-foreground)] pb-1">
            View my appointments
          </Link>
        </div>
      </div>
    )
  }

  const stepIndex = STEPS.findIndex((s) => s.key === step)

  return (
    <div className="grid gap-12 lg:grid-cols-[1fr_20rem]">
      <div>
        {/* Step rail */}
        <ol className="mb-12 flex flex-wrap gap-x-8 gap-y-2">
          {STEPS.map((s, i) => (
            <li
              key={s.key}
              className={cn(
                'label-caps flex items-center gap-2',
                i === stepIndex
                  ? 'text-[var(--color-accent)]'
                  : i < stepIndex
                    ? 'text-[var(--color-foreground)]'
                    : 'text-[var(--color-muted)]'
              )}
            >
              <span
                className={cn(
                  'flex h-6 w-6 items-center justify-center border text-[0.625rem]',
                  i === stepIndex
                    ? 'border-[var(--color-accent)]'
                    : i < stepIndex
                      ? 'border-[var(--color-foreground)]'
                      : 'border-[var(--color-border)]'
                )}
              >
                {i < stepIndex ? <Check className="h-3 w-3" strokeWidth={2.5} /> : i + 1}
              </span>
              {s.label}
            </li>
          ))}
        </ol>

        {/* ── Step 1: service ──────────────────────────── */}
        {step === 'service' && (
          <div>
            <h2 className="display text-3xl">Choose your services</h2>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              Pick as many as you would like in one visit — we will book them back to
              back as a single appointment.
            </p>

            <div className="mt-8 space-y-10">
              {groupByCategory(services).map(([catName, group]) => (
                <div key={catName}>
                  <p className="label-caps mb-4 flex items-center gap-3 text-[var(--color-muted)]">
                    {catName}
                    {group[0].category.is_intimate && <Badge tone="accent">18+</Badge>}
                  </p>
                  <div className="grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2">
                    {group.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        aria-pressed={selected.some((x) => x.id === s.id)}
                        onClick={() => {
                          toggleService(s)
                          // Re-confirm age whenever the set changes: what was
                          // attested to was a different booking.
                          setAgeConfirmed(false)
                          void trackEvent('service_selected', { service_id: s.id })
                        }}
                        className={cn(
                          'flex items-start justify-between gap-3 p-5 text-left transition-colors',
                          selected.some((x) => x.id === s.id)
                            ? 'bg-[var(--color-clay-soft)] dark:bg-[var(--color-surface)]'
                            : 'bg-[var(--color-background)] hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]'
                        )}
                      >
                        <span className="flex flex-col gap-2">
                          <span className="text-base">{s.name}</span>
                          <span className="text-xs text-[var(--color-muted)]">
                            {formatDuration(s.duration_minutes)} · {formatMoney(s.price_cents)}
                          </span>
                        </span>
                        <span
                          aria-hidden
                          className={cn(
                            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border',
                            selected.some((x) => x.id === s.id)
                              ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
                              : 'border-[var(--color-border)]'
                          )}
                        >
                          {selected.some((x) => x.id === s.id) && (
                            <Check className="h-3 w-3" strokeWidth={3} />
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Add-ons + gates for everything chosen */}
            {hasSelection && (
              <div className="mt-12 border-t border-[var(--color-border)] pt-10">
                {/* What the visit adds up to, before they commit to a time. */}
                <div className="mb-8 flex flex-wrap items-baseline justify-between gap-3 border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                  <span className="text-sm">
                    {selected.length} {selected.length === 1 ? 'service' : 'services'} ·{' '}
                    {formatDuration(totalMinutes)}
                  </span>
                  <span className="tabular-nums">{formatMoney(totalCents)}</span>
                </div>

                {availableAddons.length > 0 && (
                  <>
                    <h3 className="label-caps mb-5 text-[var(--color-accent)]">
                      Add to your service
                    </h3>
                    <div className="grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2">
                      {availableAddons.map((a) => {
                        const on = addonIds.includes(a.id)
                        return (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() =>
                              setAddonIds((ids) =>
                                on ? ids.filter((i) => i !== a.id) : [...ids, a.id]
                              )
                            }
                            className={cn(
                              'flex items-center justify-between gap-4 p-4 text-left text-sm transition-colors',
                              on
                                ? 'bg-[var(--color-clay-soft)] dark:bg-[var(--color-surface)]'
                                : 'bg-[var(--color-background)] hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]'
                            )}
                          >
                            <span className="flex items-center gap-2.5">
                              <span
                                className={cn(
                                  'flex h-4 w-4 items-center justify-center border',
                                  on
                                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]'
                                    : 'border-[var(--color-border)]'
                                )}
                              >
                                {on && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                              </span>
                              {a.name}
                            </span>
                            <span className="tabular-nums text-[var(--color-muted)]">
                              +{formatMoney(a.price_cents)}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}

                {requiresAge && (
                  <div className="mt-8 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-5 dark:bg-[var(--color-surface)]">
                    <p className="label-caps mb-3 text-[var(--color-clay-deep)] dark:text-[var(--color-accent)]">
                      Age confirmation required
                    </p>
                    <p className="mb-4 text-sm leading-relaxed text-[var(--color-muted)]">
                      This service is performed privately by a Licensed Cosmetologist. You
                      will be told exactly what is involved before anything begins, you
                      may ask for another person to be present, and you can stop at any
                      point without giving a reason.
                    </p>
                    <label className="flex cursor-pointer items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={ageConfirmed}
                        onChange={(e) => setAgeConfirmed(e.target.checked)}
                        className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <span>
                        I confirm I am {minAge} years of age or older.
                      </span>
                    </label>
                  </div>
                )}

                {patchTestHours > 0 && (
                  <p className="mt-6 text-sm text-[var(--color-muted)]">
                    This treatment needs a patch test at least {patchTestHours}{' '}
                    hours beforehand. If you have not had one with us, we will contact you
                    to arrange it before your appointment.
                  </p>
                )}
              </div>
            )}

            <div className="mt-12">
              <Button
                onClick={() => {
                  setStep('provider')
                  void trackEvent('booking_started', {
                    service_ids: selected.map((x) => x.id),
                  })
                  // The first chosen service becomes the home page's "still
                  // considering?" note. The intimate flag is frozen at write
                  // time — service OR its category — so the reader can refuse
                  // it without ever needing the catalogue (interest.ts).
                  const first = selected[0]
                  if (first) {
                    rememberConsidered({
                      slug: first.slug,
                      name: first.name,
                      intimate: first.is_intimate || first.category.is_intimate,
                    })
                  }
                }}
                disabled={!hasSelection || !ageGateSatisfied}
                size="lg"
              >
                Continue
                <ChevronRight className="h-4 w-4" strokeWidth={2} />
              </Button>
              {/* `requiresAge`, not the first service's flag: the button is
                  disabled on the aggregate, so testing selected[0] left a
                  client whose SECOND service is age-gated staring at a dead
                  Continue with nothing explaining why. */}
              {requiresAge && !ageConfirmed && (
                <p className="mt-3 text-xs text-[var(--color-muted)]">
                  Please confirm your age to continue.
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── Step 2: provider ─────────────────────────── */}
        {step === 'provider' && (
          <div>
            <h2 className="display text-3xl">Choose a provider</h2>

            {eligibleProviders.length === 0 ? (
              <p className="mt-8 text-[var(--color-muted)]">
                No one is currently taking online bookings for this service.{' '}
                <Link href="/contact" className="underline underline-offset-4">
                  Get in touch
                </Link>{' '}
                and we will find you a time.
              </p>
            ) : (
              <div className="mt-8 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2">
                {eligibleProviders.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setProvider(p)
                      // Seed the week to "today in the provider's zone" here,
                      // not in the effect that loads slots.
                      setWeekStart(dateKeyInTimeZone(new Date(), p.timezone))
                      setSelectedSlot(null)
                      setLoadingSlots(true)
                      setStep('time')
                      void trackEvent('provider_selected', { provider_id: p.id })
                    }}
                    className={cn(
                      'p-6 text-left transition-colors',
                      provider?.id === p.id
                        ? 'bg-[var(--color-clay-soft)] dark:bg-[var(--color-surface)]'
                        : 'bg-[var(--color-background)] hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]'
                    )}
                  >
                    <span className="display block text-xl">{p.display_name}</span>
                    {p.bio && (
                      <span className="mt-2 block text-sm text-[var(--color-muted)]">{p.bio}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <Button variant="ghost" className="mt-10 px-0" onClick={() => setStep('service')}>
              <ChevronLeft className="h-4 w-4" strokeWidth={2} />
              Back
            </Button>
          </div>
        )}

        {/* ── Step 3: time ─────────────────────────────── */}
        {step === 'time' && provider && (
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <h2 className="display text-3xl">Pick a time</h2>
              <p className="text-xs text-[var(--color-muted)]">
                Times shown in {timeZoneAbbreviation(new Date(), timezone)}
              </p>
            </div>

            <div className="mt-8 flex items-center justify-between">
              <Button
                variant="subtle"
                size="sm"
                disabled={
                  !weekStart ||
                  weekStart <= dateKeyInTimeZone(new Date(), timezone) ||
                  loadingSlots
                }
                onClick={() => {
                  setLoadingSlots(true)
                  setWeekStart((w) => (w ? addDaysToDateKey(w, -7) : w))
                }}
              >
                <ChevronLeft className="h-4 w-4" strokeWidth={2} />
                Earlier
              </Button>
              <span className="label-caps text-[var(--color-muted)]">
                {weekStart && formatWeekRange(weekStart)}
              </span>
              <Button
                variant="subtle"
                size="sm"
                disabled={loadingSlots}
                onClick={() => {
                  setLoadingSlots(true)
                  setWeekStart((w) => (w ? addDaysToDateKey(w, 7) : w))
                }}
              >
                Later
                <ChevronRight className="h-4 w-4" strokeWidth={2} />
              </Button>
            </div>

            {loadingSlots ? (
              <div className="flex items-center justify-center py-20 text-[var(--color-muted)]">
                <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.5} />
              </div>
            ) : days === null ? (
              <div className="mt-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center">
                <p className="text-sm">We couldn&rsquo;t load the times just now.</p>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  That&rsquo;s on our side, not yours — the calendar didn&rsquo;t answer. Nothing is booked out.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setLoadingSlots(true)
                    if (weekStart) void loadSlots(weekStart)
                  }}
                  className="label-caps mt-6 border-b border-[var(--color-foreground)] pb-1"
                >
                  Try again
                </button>
              </div>
            ) : (
              <div className="mt-8 grid grid-cols-2 gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-4 lg:grid-cols-7">
                {(days ?? []).map((d) => (
                  <div key={d.date} className="min-h-40 bg-[var(--color-background)] p-3">
                    <p className="label-caps mb-3 text-center text-[var(--color-muted)]">
                      {WEEK_DAYS[dayIndex(d.date)]}
                      <span className="mt-1 block text-sm tracking-normal text-[var(--color-foreground)]">
                        {Number(d.date.slice(8, 10))}
                      </span>
                    </p>
                    <div className="space-y-1.5">
                      {d.slots.length === 0 ? (
                        <p className="text-center text-xs text-[var(--color-muted)]">—</p>
                      ) : (
                        d.slots.map((iso) => (
                          <button
                            key={iso}
                            type="button"
                            onClick={() => {
                              setSelectedSlot(iso)
                              void trackEvent('slot_selected', { slot: iso })
                            }}
                            className={cn(
                              'w-full border px-1 py-1.5 text-xs tabular-nums transition-colors',
                              selectedSlot === iso
                                ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
                                : 'border-[var(--color-border)] hover:border-[var(--color-accent)]'
                            )}
                          >
                            {formatTimeInTimeZone(new Date(iso), timezone)}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* A full week is the moment the waitlist is worth offering — not
                buried in a contact form the client has to think to use. */}
            {days !== null && days.length > 0 && days.every((d) => d.slots.length === 0) && !loadingSlots && (
              <WaitlistJoin
                className="mt-8"
                services={services.map((s) => ({ id: s.id, name: s.name }))}
                providers={eligibleProviders.map((p) => ({
                  id: p.id,
                  display_name: p.display_name,
                }))}
                selectedServiceIds={selected.map((s) => s.id)}
                preferredProviderId={provider?.id ?? null}
                timeZone={timezone}
                fromDateKey={weekStart ?? undefined}
              />
            )}

            <div className="mt-10 flex items-center gap-4">
              <Button variant="ghost" className="px-0" onClick={() => setStep('provider')}>
                <ChevronLeft className="h-4 w-4" strokeWidth={2} />
                Back
              </Button>
              <Button onClick={() => setStep('details')} disabled={!selectedSlot} size="lg">
                Continue
                <ChevronRight className="h-4 w-4" strokeWidth={2} />
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 4: details ──────────────────────────── */}
        {step === 'details' && (
          <form onSubmit={submit}>
            <h2 className="display text-3xl">
              {!signedIn
                ? 'Your details'
                : askedCount === 0
                  ? 'Anything we should know?'
                  : askedCount === 1
                    ? 'One more detail'
                    : 'A few more details'}
            </h2>

            {signedIn ? (
              // Booking requires an account, so the name, email and number are
              // already ours. Re-asking would just be a chance to mistype them.
              <SignedInAs
                label="Booking as"
                name={[form.first_name, form.last_name].filter(Boolean).join(' ')}
                email={signedInEmail}
                href="/account/settings"
                className="mt-6"
              />
            ) : null}

            <div className="mt-8 grid gap-5 sm:grid-cols-2">
              {askFirst && (
                <Field label="First name" htmlFor="first_name" className={soloSpan}>
                  <Input
                    id="first_name"
                    required
                    maxLength={80}
                    value={form.first_name}
                    onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                  />
                </Field>
              )}
              {askLast && (
                <Field label="Last name" htmlFor="last_name" className={soloSpan}>
                  <Input
                    id="last_name"
                    required
                    maxLength={80}
                    value={form.last_name}
                    onChange={(e) => setForm({ ...form, last_name: e.target.value })}
                  />
                </Field>
              )}
              {askEmail && (
                <Field label="Email" htmlFor="email" className={soloSpan}>
                  <Input
                    id="email"
                    type="email"
                    required
                    maxLength={254}
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </Field>
              )}

              {askPhone && (
                <Field
                  label="Phone"
                  htmlFor="phone"
                  hint={
                    signedIn
                      ? 'For appointment reminders. We will keep it on your account.'
                      : 'For appointment reminders.'
                  }
                  className={soloSpan}
                >
                  <Input
                    id="phone"
                    type="tel"
                    maxLength={40}
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                </Field>
              )}

              <Field
                label="Anything we should know?"
                htmlFor="notes"
                className="sm:col-span-2"
                hint="Allergies, sensitivities, what you would like to focus on. Your health form comes next."
              >
                <Textarea
                  id="notes"
                  maxLength={2000}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </Field>
            </div>

            {error && (
              <p className="mt-6 border border-red-600/40 bg-red-50 p-4 text-sm text-red-800 dark:bg-transparent dark:text-red-400">
                {error}
              </p>
            )}

            <div className="mt-10 flex items-center gap-4">
              <Button
                type="button"
                variant="ghost"
                className="px-0"
                onClick={() => setStep('time')}
              >
                <ChevronLeft className="h-4 w-4" strokeWidth={2} />
                Back
              </Button>
              <Button type="submit" size="lg" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                    Booking…
                  </>
                ) : depositCents > 0 ? (
                  `Book · ${formatMoney(depositCents)} deposit`
                ) : (
                  'Confirm booking'
                )}
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* ── Summary rail ──────────────────────────────── */}
      <aside className="lg:sticky lg:top-28 lg:self-start">
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <p className="label-caps mb-5 text-[var(--color-accent)]">Your booking</p>

          {!hasSelection ? (
            <p className="text-sm text-[var(--color-muted)]">Choose a service to begin.</p>
          ) : (
            <dl className="space-y-4 text-sm">
              <div>
                <dt className="text-[var(--color-muted)]">
                  {selected.length === 1 ? 'Service' : 'Services'}
                </dt>
                <dd className="mt-0.5">
                  {/* Listed rather than joined, so a two-service visit reads as
                      two lines with their own prices. */}
                  <ul className="space-y-1">
                    {selected.map((x) => (
                      <li key={x.id} className="flex justify-between gap-3">
                        <span>{x.name}</span>
                        <span className="shrink-0 tabular-nums text-[var(--color-muted)]">
                          {formatMoney(x.price_cents)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>

              {selectedAddons.length > 0 && (
                <div>
                  <dt className="text-[var(--color-muted)]">Add-ons</dt>
                  <dd className="mt-0.5">{selectedAddons.map((a) => a.name).join(', ')}</dd>
                </div>
              )}

              {provider && (
                <div>
                  <dt className="text-[var(--color-muted)]">Provider</dt>
                  <dd className="mt-0.5">{provider.display_name}</dd>
                </div>
              )}

              {selectedSlot && (
                <div>
                  <dt className="text-[var(--color-muted)]">When</dt>
                  <dd className="mt-0.5">{formatDateTime(selectedSlot, timezone)}</dd>
                </div>
              )}

              <div className="flex justify-between border-t border-[var(--color-border)] pt-4">
                <dt className="text-[var(--color-muted)]">Duration</dt>
                <dd className="tabular-nums">{formatDuration(totalMinutes)}</dd>
              </div>

              <div className="flex justify-between">
                <dt className="text-[var(--color-muted)]">Total</dt>
                <dd className="tabular-nums">{formatMoney(totalCents)}</dd>
              </div>

              {depositCents > 0 && (
                <div className="flex justify-between border-t border-[var(--color-border)] pt-4">
                  <dt>Due now</dt>
                  <dd className="tabular-nums">{formatMoney(depositCents)}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
      </aside>
    </div>
  )
}

// ── helpers ────────────────────────────────────────────────
function groupByCategory(services: BookableService[]): [string, BookableService[]][] {
  const map = new Map<string, BookableService[]>()
  for (const s of services) {
    const list = map.get(s.category.name) ?? []
    list.push(s)
    map.set(s.category.name, list)
  }
  return Array.from(map.entries())
}

function dayIndex(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

function formatWeekRange(startKey: string): string {
  const endKey = addDaysToDateKey(startKey, 6)
  const fmt = (k: string) => {
    const [y, m, d] = k.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
    })
  }
  return `${fmt(startKey)} – ${fmt(endKey)}`
}

function formatDateTime(iso: string, timeZone: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })} at ${formatTimeInTimeZone(d, timeZone)}`
}
