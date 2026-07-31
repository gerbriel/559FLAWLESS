'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
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

export interface BookableService {
  id: number
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
  signedInEmail,
  signedInName,
}: {
  services: BookableService[]
  providers: BookableProvider[]
  initialServiceSlug?: string
  signedInEmail?: string | null
  signedInName?: { first: string; last: string } | null
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
  const [service, setService] = useState<BookableService | null>(deepLinked)
  const [addonIds, setAddonIds] = useState<number[]>([])
  const [provider, setProvider] = useState<BookableProvider | null>(null)
  const [ageConfirmed, setAgeConfirmed] = useState(false)

  const [weekStart, setWeekStart] = useState<string | null>(null)
  const [days, setDays] = useState<DayResult[]>([])
  const [timezone, setTimezone] = useState('America/Los_Angeles')
  const [loadingSlots, setLoadingSlots] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null)

  const [form, setForm] = useState({
    first_name: signedInName?.first ?? '',
    last_name: signedInName?.last ?? '',
    email: signedInEmail ?? '',
    phone: '',
    notes: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{
    id: string
    startsAt: string
    depositCents: number
    totalCents: number
  } | null>(null)

  const eligibleProviders = useMemo(
    () => (service ? providers.filter((p) => p.service_ids.includes(service.id)) : []),
    [providers, service]
  )

  const selectedAddons = useMemo(
    () => service?.addons.filter((a) => addonIds.includes(a.id)) ?? [],
    [service, addonIds]
  )

  const totalCents =
    (service?.price_cents ?? 0) + selectedAddons.reduce((n, a) => n + a.price_cents, 0)
  const totalMinutes =
    (service?.duration_minutes ?? 0) + selectedAddons.reduce((n, a) => n + a.duration_minutes, 0)

  const ageGateSatisfied = !service?.requires_age_verification || ageConfirmed

  // ── Slot loading ─────────────────────────────────────────
  // The spinner is turned ON by whichever interaction starts a load (choosing a
  // provider, stepping the week) and turned OFF here when the data lands. That
  // keeps the effect a pure fetch with no synchronous setState of its own.
  const loadSlots = useCallback(
    async (from: string) => {
      if (!service || !provider) return
      try {
        const qs = new URLSearchParams({
          provider: provider.id,
          service: String(service.id),
          from,
          days: '7',
        })
        if (addonIds.length) qs.set('addons', addonIds.join(','))

        const res = await fetch(`/api/availability?${qs}`)
        if (!res.ok) {
          setDays([])
          return
        }
        const data = await res.json()
        setDays(data.days ?? [])
        setTimezone(data.timezone ?? provider.timezone)
      } finally {
        setLoadingSlots(false)
      }
    },
    [service, provider, addonIds]
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
    if (!service || !provider || !selectedSlot) return

    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: provider.id,
          service_id: service.id,
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
        service_id: service.id,
        provider_id: provider.id,
      })

      setConfirmation({
        id: data.booking.id,
        startsAt: data.booking.startsAt,
        depositCents: data.booking.depositCents,
        totalCents: data.booking.totalCents,
      })
      setStep('done')

      if (data.booking.depositCents > 0) {
        // Send them straight to Stripe to secure the slot.
        const checkout = await fetch('/api/stripe/deposit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appointment_id: data.booking.id }),
        })
        const checkoutData = await checkout.json()
        if (checkout.ok && checkoutData.url) {
          window.location.assign(checkoutData.url)
          return
        }
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
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center border border-[var(--color-accent)]">
          <Check className="h-6 w-6 text-[var(--color-accent)]" strokeWidth={1.5} />
        </div>
        <h2 className="display mt-8 text-4xl">You&rsquo;re booked.</h2>
        <p className="mt-4 text-[var(--color-muted)]">
          {service?.name} with {provider?.display_name}
        </p>
        <p className="mt-1 text-lg">
          {formatDateTime(confirmation.startsAt, timezone)}{' '}
          <span className="text-sm text-[var(--color-muted)]">
            {timeZoneAbbreviation(new Date(confirmation.startsAt), timezone)}
          </span>
        </p>

        {confirmation.depositCents > 0 && (
          <p className="mt-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-muted)]">
            Taking you to secure checkout to pay the{' '}
            {formatMoney(confirmation.depositCents)} deposit. Your slot is held until
            then.
          </p>
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
            <h2 className="display text-3xl">Choose a service</h2>

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
                        onClick={() => {
                          setService(s)
                          setAddonIds([])
                          setProvider(null)
                          setSelectedSlot(null)
                          setAgeConfirmed(false)
                          void trackEvent('service_selected', { service_id: s.id })
                        }}
                        className={cn(
                          'flex flex-col items-start gap-2 p-5 text-left transition-colors',
                          service?.id === s.id
                            ? 'bg-[var(--color-clay-soft)] dark:bg-[var(--color-surface)]'
                            : 'bg-[var(--color-background)] hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]'
                        )}
                      >
                        <span className="text-base">{s.name}</span>
                        <span className="text-xs text-[var(--color-muted)]">
                          {formatDuration(s.duration_minutes)} · {formatMoney(s.price_cents)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Add-ons + age gate for the chosen service */}
            {service && (
              <div className="mt-12 border-t border-[var(--color-border)] pt-10">
                {service.addons.length > 0 && (
                  <>
                    <h3 className="label-caps mb-5 text-[var(--color-accent)]">
                      Add to your service
                    </h3>
                    <div className="grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2">
                      {service.addons.map((a) => {
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

                {service.requires_age_verification && (
                  <div className="mt-8 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-5 dark:bg-[var(--color-surface)]">
                    <p className="label-caps mb-3 text-[var(--color-clay-deep)] dark:text-[var(--color-accent)]">
                      Age confirmation required
                    </p>
                    <p className="mb-4 text-sm leading-relaxed text-[var(--color-muted)]">
                      This service is performed privately by a licensed esthetician. You
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
                        I confirm I am {service.min_age} years of age or older.
                      </span>
                    </label>
                  </div>
                )}

                {service.patch_test_hours > 0 && (
                  <p className="mt-6 text-sm text-[var(--color-muted)]">
                    This treatment needs a patch test at least {service.patch_test_hours}{' '}
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
                  void trackEvent('booking_started', { service_id: service?.id })
                }}
                disabled={!service || !ageGateSatisfied}
                size="lg"
              >
                Continue
                <ChevronRight className="h-4 w-4" strokeWidth={2} />
              </Button>
              {service?.requires_age_verification && !ageConfirmed && (
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
            ) : (
              <div className="mt-8 grid grid-cols-2 gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-4 lg:grid-cols-7">
                {days.map((d) => (
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

            {days.length > 0 && days.every((d) => d.slots.length === 0) && !loadingSlots && (
              <p className="mt-6 text-sm text-[var(--color-muted)]">
                Nothing open this week. Try a later week, or{' '}
                <Link href="/contact" className="underline underline-offset-4">
                  message us
                </Link>{' '}
                about the waitlist.
              </p>
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
            <h2 className="display text-3xl">Your details</h2>

            <div className="mt-8 grid gap-5 sm:grid-cols-2">
              <Field label="First name" htmlFor="first_name">
                <Input
                  id="first_name"
                  required
                  maxLength={80}
                  value={form.first_name}
                  onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                />
              </Field>
              <Field label="Last name" htmlFor="last_name">
                <Input
                  id="last_name"
                  required
                  maxLength={80}
                  value={form.last_name}
                  onChange={(e) => setForm({ ...form, last_name: e.target.value })}
                />
              </Field>
              <Field label="Email" htmlFor="email">
                <Input
                  id="email"
                  type="email"
                  required
                  maxLength={254}
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </Field>
              <Field label="Phone" htmlFor="phone" hint="For appointment reminders.">
                <Input
                  id="phone"
                  type="tel"
                  maxLength={40}
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </Field>
              <Field
                label="Anything we should know?"
                htmlFor="notes"
                className="sm:col-span-2"
                hint="Allergies, sensitivities, what you would like to focus on. You will complete a full health form before your visit."
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
                ) : service && service.deposit_cents > 0 ? (
                  `Book · ${formatMoney(service.deposit_cents)} deposit`
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

          {!service ? (
            <p className="text-sm text-[var(--color-muted)]">Choose a service to begin.</p>
          ) : (
            <dl className="space-y-4 text-sm">
              <div>
                <dt className="text-[var(--color-muted)]">Service</dt>
                <dd className="mt-0.5">{service.name}</dd>
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

              {service.deposit_cents > 0 && (
                <div className="flex justify-between border-t border-[var(--color-border)] pt-4">
                  <dt>Due now</dt>
                  <dd className="tabular-nums">{formatMoney(service.deposit_cents)}</dd>
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
