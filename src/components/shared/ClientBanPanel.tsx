'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Ban, ShieldOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { zonedTimeToUtc, dateKeyInTimeZone, addDaysToDateKey } from '@/lib/time'
import { banIsLive, BANNED_BOOKING_MESSAGE, type ClientBanWithActors } from '@/types/clientprofile'

export interface BanLocation {
  id: number
  name: string
}

/**
 * Whether the studio will take this person's bookings.
 *
 * Recording a ban is open to anyone on staff: in a one-room studio the person
 * who needs to stop the next booking is the person who was in the room. Lifting
 * one is a manager's call, which is why `canLift` is passed in — though the UI
 * only hides the button, and `client_bans`' own policies are what actually
 * decide.
 *
 * Nothing here is ever shown to the client. The reason is a staff note; what
 * the client meets is a polite decline at the point of booking.
 */
export function ClientBanPanel({
  clientId,
  clientName,
  bans,
  locations,
  currentLocationId,
  timeZone,
  canLift,
  now,
}: {
  clientId: string
  clientName: string
  bans: ClientBanWithActors[]
  locations: BanLocation[]
  currentLocationId: number
  timeZone: string
  canLift: boolean
  /** Read once on the server through `requestNow()` — a bare `Date.now()` in a
   *  component body is an impure call during render, and the compiler lint
   *  rightly refuses it. */
  now: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [reason, setReason] = useState('')
  const [scope, setScope] = useState<'studio' | 'location'>('studio')
  const [locationId, setLocationId] = useState(String(currentLocationId))
  const [ends, setEnds] = useState<'never' | 'date'>('never')
  const [until, setUntil] = useState('')
  const [liftReason, setLiftReason] = useState('')
  const [lifting, setLifting] = useState<number | null>(null)

  // One instant for the whole panel: a ban that expires mid-render must not
  // appear as both live and past.
  const live = bans.filter((b) => banIsLive(b, now))
  const past = bans.filter((b) => !banIsLive(b, now))

  const today = dateKeyInTimeZone(new Date(now), timeZone)

  async function record(e: React.FormEvent) {
    e.preventDefault()
    if (!reason.trim()) {
      toast.error('Write down why. Nobody can review a ban with no reason on it.')
      return
    }
    if (ends === 'date' && !until) {
      toast.error('Pick the date it ends, or choose "until we lift it".')
      return
    }

    setBusy(true)
    const supabase = createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      setBusy(false)
      toast.error('Please sign in again.')
      return
    }

    // The date input is already a wall-clock key in the studio's zone; end of
    // that day there is the instant the ban stops. Converted through time.ts so
    // a ban set on the Saturday before the clocks change still ends when the
    // person reading the calendar thinks it does.
    const expiresAt =
      ends === 'date' ? zonedTimeToUtc(until, '23:59', timeZone).toISOString() : null

    const { error } = await supabase.from('client_bans').insert({
      client_id: clientId,
      // banned_by must equal auth.uid(); the insert policy enforces it, so a
      // ban can never be attributed to a colleague who did not make the call.
      banned_by: user.id,
      reason: reason.trim(),
      applies_studio_wide: scope === 'studio',
      location_id: scope === 'studio' ? currentLocationId : Number(locationId),
      expires_at: expiresAt,
    })

    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not record that.')
      return
    }

    setReason('')
    setUntil('')
    setEnds('never')
    setOpen(false)
    toast.success(`${clientName} can no longer book online.`)
    router.refresh()
  }

  async function lift(id: number) {
    setBusy(true)
    const { error } = await createClient()
      .from('client_bans')
      .update({
        lifted_at: new Date().toISOString(),
        lift_reason: liftReason.trim() || null,
      })
      .eq('id', id)
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not lift it.')
      return
    }

    setLifting(null)
    setLiftReason('')
    toast.success(`${clientName} can book again.`)
    router.refresh()
  }

  return (
    <section>
      <h2 className="display text-2xl">Booking status</h2>

      {live.length === 0 ? (
        <div className="mt-6">
          {!open ? (
            <>
              <p className="text-sm text-[var(--color-muted)]">
                Bookings are open. Nothing is stopping {clientName} from booking.
              </p>
              <div className="mt-4">
                <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
                  <Ban className="h-4 w-4" strokeWidth={1.5} />
                  Stop taking bookings
                </Button>
              </div>
            </>
          ) : (
            <form
              onSubmit={record}
              className="space-y-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
            >
              <Field
                label="Why"
                htmlFor="ban_reason"
                hint="Staff only. Written down so it can be reviewed later — and so whoever picks up the phone knows what happened."
              >
                <Textarea
                  id="ban_reason"
                  required
                  rows={3}
                  maxLength={1000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Three no-shows in six weeks, and abusive on the phone about the fee."
                />
              </Field>

              {locations.length > 1 && (
                <>
                  <Field label="Where it applies" htmlFor="ban_scope">
                    <Select
                      id="ban_scope"
                      value={scope}
                      onChange={(e) => setScope(e.target.value as 'studio' | 'location')}
                    >
                      <option value="studio">Every site</option>
                      <option value="location">One site only</option>
                    </Select>
                  </Field>

                  {scope === 'location' && (
                    <Field
                      label="Which site"
                      htmlFor="ban_location"
                      hint="The other site keeps taking her bookings."
                    >
                      <Select
                        id="ban_location"
                        value={locationId}
                        onChange={(e) => setLocationId(e.target.value)}
                      >
                        {locations.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                </>
              )}

              <Field label="How long" htmlFor="ban_ends">
                <Select
                  id="ban_ends"
                  value={ends}
                  onChange={(e) => setEnds(e.target.value as 'never' | 'date')}
                >
                  <option value="never">Until we lift it</option>
                  <option value="date">Until a date</option>
                </Select>
              </Field>

              {ends === 'date' && (
                <Field label="Ends after" htmlFor="ban_until" hint="Bookings reopen by themselves the next morning.">
                  <Input
                    id="ban_until"
                    type="date"
                    required
                    min={addDaysToDateKey(today, 1)}
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                  />
                </Field>
              )}

              <p className="border-l-2 border-[var(--color-border)] pl-3 text-xs text-[var(--color-muted)]">
                {clientName} is not told any of this. Her account keeps working, her
                history stays where it is, and online booking simply declines:{' '}
                <span className="italic">“{BANNED_BOOKING_MESSAGE}”</span>
              </p>

              <div className="flex gap-3">
                <Button type="submit" size="sm" variant="danger" disabled={busy}>
                  {busy ? 'Saving…' : 'Stop taking bookings'}
                </Button>
                <Button type="button" size="sm" variant="subtle" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : (
        <ul className="mt-6 space-y-4">
          {live.map((b) => (
            <li key={b.id} className="border-l-2 border-red-700 bg-red-50 p-5 dark:bg-transparent">
              <div className="flex flex-wrap items-center gap-2">
                <p className="label-caps flex items-center gap-2 text-red-800 dark:text-red-400">
                  <ShieldOff className="h-3.5 w-3.5" strokeWidth={2} />
                  Not taking bookings
                </p>
                <Badge tone={b.applies_studio_wide ? 'danger' : 'warning'}>
                  {b.applies_studio_wide ? 'Every site' : (b.locations?.name ?? 'One site')}
                </Badge>
                {b.expires_at && (
                  <Badge tone="neutral">Until {shortDate(b.expires_at, timeZone)}</Badge>
                )}
              </div>

              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed">{b.reason}</p>

              <p className="mt-3 text-xs text-[var(--color-muted)]">
                {actorName(b.banned_by_profile) ?? 'Someone'} ·{' '}
                {shortDate(b.banned_at, timeZone)}
                {!b.expires_at && ' · no end date'}
              </p>

              {canLift &&
                (lifting === b.id ? (
                  <div className="mt-4 space-y-3">
                    <Field label="What changed" htmlFor={`lift_${b.id}`}>
                      <Input
                        id={`lift_${b.id}`}
                        maxLength={500}
                        value={liftReason}
                        onChange={(e) => setLiftReason(e.target.value)}
                        placeholder="Apologised, paid the outstanding fee."
                      />
                    </Field>
                    <div className="flex gap-3">
                      <Button size="sm" disabled={busy} onClick={() => lift(b.id)}>
                        {busy ? 'Saving…' : 'Lift it'}
                      </Button>
                      <Button
                        size="sm"
                        variant="subtle"
                        onClick={() => {
                          setLifting(null)
                          setLiftReason('')
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4">
                    <Button size="sm" variant="subtle" onClick={() => setLifting(b.id)}>
                      Let her book again
                    </Button>
                  </div>
                ))}
            </li>
          ))}
        </ul>
      )}

      {past.length > 0 && (
        <div className="mt-8">
          <h3 className="label-caps mb-3 text-[var(--color-muted)]">Previously</h3>
          <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {past.map((b) => (
              <li key={b.id} className="py-3 text-sm">
                <p className="text-[var(--color-muted)]">{b.reason}</p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {shortDate(b.banned_at, timeZone)} —{' '}
                  {b.lifted_at
                    ? `lifted ${shortDate(b.lifted_at, timeZone)}${
                        actorName(b.lifted_by_profile) ? ` by ${actorName(b.lifted_by_profile)}` : ''
                      }`
                    : `expired ${shortDate(b.expires_at!, timeZone)}`}
                  {b.lift_reason && ` · ${b.lift_reason}`}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function actorName(p: { first_name: string | null; last_name: string | null } | null): string | null {
  if (!p) return null
  const name = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
  return name || null
}

/** Rendered in the site's own zone — `locations.timezone` is authoritative. */
function shortDate(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}
