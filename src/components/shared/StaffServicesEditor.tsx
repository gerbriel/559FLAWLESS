'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils'

/** A heading in the menu. `sort_order` is the studio's own order, applied on the server. */
export type ServiceCategoryOption = {
  id: number
  name: string
}

/**
 * One line of the menu, as far as this screen is concerned.
 *
 * `is_active` here is the SERVICE's — whether it is on the menu at all — and has
 * nothing to do with `provider_services.is_active`, which is whether this person
 * performs it. A service retired from the menu is still listed below if someone
 * is still linked to it, so that link can be undone.
 */
export type AssignableService = {
  id: number
  category_id: number
  name: string
  price_cents: number
  duration_minutes: number
  is_active: boolean
  requires_consultation: boolean
}

/** One row of `provider_services`, for the person this block is about. */
export type ProviderServiceLink = {
  service_id: number
  is_active: boolean
  price_cents: number | null
  duration_minutes: number | null
}

const CATEGORY_OTHER = -1

/**
 * Which services a member of staff performs.
 *
 * ── Why this is a manager's control and not an admin's ───────
 * `provider_services` has carried the right policy since migration 003:
 *
 *   create policy "provider manages own services" on public.provider_services
 *     for all using (provider_id = auth.uid() or public.is_manager())
 *     with check (provider_id = auth.uid() or public.is_manager());
 *
 * so a manager has always been permitted to do this and there was simply never a
 * screen for it. `canEdit` hides the control; the policy is what refuses the
 * write. Everyone else reads the same list as text — the public half of that
 * table is readable by anyone (`using (is_active)`), so there is nothing to hide,
 * only something they may not change.
 *
 * ── Off means inactive, never deleted ────────────────────────
 * Removing a service sets `is_active = false` rather than deleting the row, for
 * two reasons that both bite later. The row also holds `price_cents` and
 * `duration_minutes` — the per-provider override a senior esthetician charges
 * for the same facial — and deleting throws that away silently, so putting the
 * service back next month quietly reprices it to the catalogue. And an inactive
 * row still records that they used to perform it, which a deleted row does not.
 * Nothing is lost by keeping it: the public read policy is `using (is_active)`,
 * so an inactive row is as invisible to the booking page as no row at all.
 *
 * ── Appointments already booked are not touched ──────────────
 * `src/lib/availability.ts` never reads this table; `priceService()` in
 * src/lib/booking.ts reads it only while creating a NEW booking, and the move
 * route only when handing an appointment to a DIFFERENT provider. An appointment
 * that already exists is rows in `appointments` and `appointment_services` with
 * the price and duration snapshotted at the time. So switching a service off
 * stops the next booking and leaves the diary alone — which is said out loud
 * below, because a manager who is not sure will simply never touch this.
 */
export function StaffServicesEditor({
  providerId,
  personName,
  isSelf,
  canEdit,
  bookableOnline,
  categories,
  services,
  links,
  upcoming,
}: {
  providerId: string
  /** First name or display name — this component addresses a person. */
  personName: string
  isSelf: boolean
  /** The VIEWER's right to write, not the subject's. Manager, per 003. */
  canEdit: boolean
  /** `profiles.accepts_online_booking` for this person. */
  bookableOnline: boolean
  categories: ServiceCategoryOption[]
  services: AssignableService[]
  links: ProviderServiceLink[]
  /** Upcoming appointments for this provider, counted per service id. */
  upcoming: Record<number, number>
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  // What the database currently says, rebuilt every render from props. After a
  // save + router.refresh() this becomes equal to `chosen` again, which is what
  // clears the dirty state — no effect syncing one to the other.
  const saved = new Set(links.filter((l) => l.is_active).map((l) => l.service_id))

  const [chosen, setChosen] = useState<Set<number>>(
    () => new Set(links.filter((l) => l.is_active).map((l) => l.service_id))
  )

  const overrideFor = new Map(links.map((l) => [l.service_id, l]))

  const added = [...chosen].filter((id) => !saved.has(id))
  const removed = [...saved].filter((id) => !chosen.has(id))
  const dirty = added.length > 0 || removed.length > 0

  // A retired service is still listed while somebody is linked to it, so the
  // link can be undone; otherwise the menu is the menu.
  const listable = services.filter((s) => s.is_active || saved.has(s.id) || chosen.has(s.id))

  // Grouped the way the menu is grouped, in the studio's own category order —
  // forty services in one flat column is not a list anybody reads.
  const categoryIds = new Set(categories.map((c) => c.id))
  // A service whose category the viewer cannot see. Rare, and silently dropping
  // a service somebody performs is worse than an extra heading.
  const orphans = listable.filter((s) => !categoryIds.has(s.category_id))
  const grouped = [
    ...categories.map((c) => ({
      id: c.id,
      name: c.name,
      items: listable.filter((s) => s.category_id === c.id),
    })),
    { id: CATEGORY_OTHER, name: 'Uncategorised', items: orphans },
  ].filter((g) => g.items.length > 0)

  const removedWithBookings = removed.filter((id) => (upcoming[id] ?? 0) > 0)
  const upcomingAtRisk = removedWithBookings.reduce((n, id) => n + (upcoming[id] ?? 0), 0)

  const who = isSelf ? 'You' : personName
  const whoLower = isSelf ? 'you' : personName
  const nameOf = (id: number) => services.find((s) => s.id === id)?.name ?? `Service #${id}`

  function toggle(id: number, on: boolean) {
    setChosen((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function setGroup(ids: number[], on: boolean) {
    setChosen((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  async function save() {
    // Both halves are an upsert on the composite primary key. Turning one ON may
    // be reviving a row that is already there with an override price on it, and
    // sending only these three columns leaves `price_cents` and
    // `duration_minutes` exactly where they were.
    const rows = [
      ...added.map((id) => ({ provider_id: providerId, service_id: id, is_active: true })),
      ...removed.map((id) => ({ provider_id: providerId, service_id: id, is_active: false })),
    ]
    if (rows.length === 0) return

    setBusy(true)
    const { error } = await createClient()
      .from('provider_services')
      .upsert(rows, { onConflict: 'provider_id,service_id' })
    setBusy(false)

    if (error) {
      toast.error(
        // 42501 is the policy above saying no. Worth naming, because the reason
        // is a permission and not a typo.
        error.code === '42501'
          ? 'The database refused that — only a manager may set someone else’s services.'
          : error.message || 'Could not save that.'
      )
      return
    }

    toast.success(
      added.length > 0 && removed.length > 0
        ? `Added ${added.length}, removed ${removed.length}.`
        : added.length > 0
          ? `${added.length} service${added.length === 1 ? '' : 's'} added.`
          : `${removed.length} service${removed.length === 1 ? '' : 's'} removed.`
    )
    router.refresh()
  }

  const savedList = listable.filter((s) => saved.has(s.id))

  /**
   * The denominator on the count badge.
   *
   * Not simply "how long is the menu": somebody may still be linked to a
   * service that has since been taken off it, and those are counted above, so a
   * plain menu length reads "9 of 8". Anything they hold that is no longer on
   * the menu is added to the total it is being counted against.
   */
  const countableTotal = services.filter((s) => s.is_active || saved.has(s.id)).length

  return (
    <section>
      <div className="flex flex-wrap items-center gap-3">
        <p className="label-caps text-[var(--color-accent)]">
          {isSelf ? 'Services you perform' : 'Services they perform'}
        </p>
        <Badge tone={savedList.length === 0 ? 'warning' : 'neutral'} size="sm">
          {savedList.length === 0 ? 'None' : `${savedList.length} of ${countableTotal}`}
        </Badge>
      </div>

      {savedList.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {savedList.map((s) => (
            <li key={s.id}>
              <Badge
                tone={s.is_active ? 'neutral' : 'warning'}
                title={s.is_active ? undefined : 'Still assigned, but no longer on the menu'}
              >
                {s.name}
              </Badge>
            </li>
          ))}
        </ul>
      ) : bookableOnline ? (
        // The consequence, stated where it is discovered, and only alarming when
        // it is a contradiction: this person is offered to the public and has
        // nothing to offer them. `BookingFlow` filters providers with
        // `selected.every((s) => p.service_ids.includes(s.id))`, so an empty list
        // fails that test for every possible selection.
        <p className="mt-3 border-l-2 border-amber-600 bg-amber-50 p-4 text-sm leading-relaxed text-[var(--color-muted)] dark:bg-transparent">
          <span className="text-[var(--color-foreground)]">
            {who} perform{isSelf ? '' : 's'} nothing, so {whoLower} cannot be booked online
            at all.
          </span>{' '}
          A client picks a treatment first and is then offered whoever performs it, so with
          nothing ticked {whoLower} {isSelf ? 'are' : 'is'} offered for nothing. The
          “Bookable online” switch is already on and cannot make up for it.
        </p>
      ) : (
        // Same fact, no alarm: somebody who is not on the booking page and
        // performs nothing is a front-desk hire, not a misconfiguration.
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
          Nothing assigned, and {whoLower} {isSelf ? 'are' : 'is'} not on the booking page
          either — consistent, and quite normal for anyone who does not treat clients.
          Assigning a service is only half of being bookable: “Bookable online” is an
          admin&rsquo;s switch, and without at least one service here it does nothing on
          its own.
        </p>
      )}

      {canEdit ? (
        <details className="mt-4 border-t border-[var(--color-border)]">
          <summary className="label-caps min-h-11 cursor-pointer py-3 text-[var(--color-muted)] hover:text-[var(--color-accent)]">
            {isSelf ? 'Change what you perform' : `Change what ${personName} performs`}
          </summary>

          <p className="mt-1 mb-6 max-w-prose text-xs leading-relaxed text-[var(--color-muted)]">
            Ticking a service lets it be booked with {whoLower} from the next booking
            onwards. Unticking one stops new bookings and{' '}
            <span className="text-[var(--color-foreground)]">
              leaves every appointment already in the diary exactly where it is
            </span>{' '}
            — an appointment keeps the price and duration it was booked at, and nothing
            re-reads this list afterwards. Nothing is deleted either: a service switched
            off keeps any price or duration set specially for {whoLower}, ready for if it
            comes back.
          </p>

          {grouped.length === 0 && (
            // A studio that has not written its menu yet. Without this the
            // disclosure opens on a paragraph, a rule and a dead Save button,
            // and the reason — there is nothing to tick — is nowhere on screen.
            // Said here rather than in the block above, because "performs
            // nothing" is true either way and only a manager can act on it.
            <p className="mb-8 max-w-prose border-l-2 border-amber-600 bg-amber-50 p-4 text-sm leading-relaxed text-[var(--color-muted)] dark:bg-transparent">
              <span className="text-[var(--color-foreground)]">
                There are no treatments to assign yet.
              </span>{' '}
              Nobody can be given one until the studio&rsquo;s menu has something on it —
              add the treatments the studio offers on{' '}
              <Link href="/dashboard/services" className="underline underline-offset-4">
                Services
              </Link>
              , then come back here and tick the ones {whoLower}{' '}
              {isSelf ? 'perform' : 'performs'}.
            </p>
          )}

          <div className="space-y-8">
            {grouped.map((group) => {
              const ids = group.items.map((s) => s.id)
              const on = ids.filter((id) => chosen.has(id)).length
              return (
                <fieldset key={group.id}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] pb-2">
                    <legend className="label-caps text-[var(--color-muted)]">
                      {group.name}{' '}
                      <span className="tabular-nums">
                        ({on}/{ids.length})
                      </span>
                    </legend>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy || on === ids.length}
                        onClick={() => setGroup(ids, true)}
                      >
                        All
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy || on === 0}
                        onClick={() => setGroup(ids, false)}
                      >
                        None
                      </Button>
                    </div>
                  </div>

                  <ul className="grid gap-x-6 sm:grid-cols-2">
                    {group.items.map((s) => {
                      const link = overrideFor.get(s.id)
                      const booked = upcoming[s.id] ?? 0
                      return (
                        <li key={s.id}>
                          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-sm">
                            <input
                              type="checkbox"
                              checked={chosen.has(s.id)}
                              disabled={busy}
                              onChange={(e) => toggle(s.id, e.target.checked)}
                              className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                            />
                            <span className="min-w-0">
                              <span className="block">{s.name}</span>
                              <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                                <span className="tabular-nums">
                                  {formatMoney(link?.price_cents ?? s.price_cents)} ·{' '}
                                  {link?.duration_minutes ?? s.duration_minutes} min
                                </span>
                                {link?.price_cents != null || link?.duration_minutes != null ? (
                                  <> · set specially for {whoLower}</>
                                ) : null}
                                {booked > 0 && (
                                  <>
                                    {' '}
                                    · <span className="tabular-nums">{booked}</span> booked ahead
                                  </>
                                )}
                              </span>
                              {!s.is_active && (
                                <span className="mt-1 inline-flex">
                                  <Badge tone="warning" size="sm">
                                    Off the menu
                                  </Badge>
                                </span>
                              )}
                              {s.is_active && s.requires_consultation && (
                                <span className="mt-1 inline-flex">
                                  <Badge tone="info" size="sm">
                                    Consultation first
                                  </Badge>
                                </span>
                              )}
                            </span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </fieldset>
              )
            })}
          </div>

          {chosen.size === 0 && saved.size > 0 && (
            <p className="mt-8 flex items-start gap-3 border-l-2 border-amber-600 bg-amber-50 p-4 text-sm leading-relaxed text-[var(--color-muted)] dark:bg-transparent">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400"
                strokeWidth={1.5}
                aria-hidden
              />
              <span>
                Saving with nothing ticked takes {whoLower} off the booking page entirely
                — not paused, absent, because there is no treatment left to offer.
                Appointments already booked stay in the diary.
              </span>
            </p>
          )}

          {upcomingAtRisk > 0 && (
            <p className="mt-8 border-l-2 border-[var(--color-sage)] bg-[var(--color-sage)]/10 p-4 text-sm leading-relaxed text-[var(--color-muted)] dark:bg-transparent">
              {upcomingAtRisk} upcoming appointment{upcomingAtRisk === 1 ? '' : 's'} —{' '}
              {removedWithBookings.map(nameOf).join(', ')} — {upcomingAtRisk === 1 ? 'is' : 'are'}{' '}
              booked for {removedWithBookings.length === 1 ? 'a service' : 'services'} you are
              switching off.{' '}
              <span className="text-[var(--color-foreground)]">
                {upcomingAtRisk === 1 ? 'It stays' : 'They stay'} booked and nobody is told
                anything
              </span>{' '}
              — this only stops the next client reserving it. Cancel or move{' '}
              {upcomingAtRisk === 1 ? 'it' : 'them'} from the calendar if that is what you
              meant.
            </p>
          )}

          <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-[var(--color-border)] pt-6">
            <Button type="button" onClick={save} disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save services'}
            </Button>
            {dirty && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setChosen(new Set(saved))}
                >
                  Discard
                </Button>
                <p className="text-xs text-[var(--color-muted)]">
                  {[
                    added.length > 0 ? `${added.length} to add` : null,
                    removed.length > 0 ? `${removed.length} to remove` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </>
            )}
            {!isSelf && !dirty && (
              <p className="text-xs text-[var(--color-muted)]">
                You are setting this for someone else.
              </p>
            )}
          </div>
        </details>
      ) : (
        <p className="mt-4 max-w-prose text-xs leading-relaxed text-[var(--color-muted)]">
          {isSelf ? (
            <>
              A manager decides which treatments are assigned to you — the same list
              appears beside your working hours on{' '}
              <Link href="/dashboard/calendar/hours" className="underline underline-offset-4">
                My hours
              </Link>
              , which is where you set the times you work and the days you are away. Ask a
              manager to add or remove a treatment.
            </>
          ) : (
            <>
              Only a manager may change what somebody else performs, and the database
              enforces that rather than this page. Yours are on{' '}
              <Link href="/dashboard/calendar/hours" className="underline underline-offset-4">
                My hours
              </Link>
              .
            </>
          )}
        </p>
      )}
    </section>
  )
}
