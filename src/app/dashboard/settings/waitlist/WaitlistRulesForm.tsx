'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'
import type { WaitlistSettings } from '@/types/resources'

/**
 * The CHECK constraints from 037, mirrored so this form never offers a value the
 * database will refuse. The database is the authority — these exist to turn a
 * save that would fail into a field that cannot be filled in wrongly.
 *
 *   batch_size            between 1 and 50
 *   claim_window_minutes  between 5 and 10080
 *   urgent_within_hours   >= 0            (no upper bound in SQL)
 *   max_offers_per_entry  between 1 and 20
 *   default_expiry_days   between 1 and 365
 *   urgent_max_recipients between 1 and 200
 */
const RANGES = {
  batch_size: { min: 1, max: 50 },
  max_offers_per_entry: { min: 1, max: 20 },
  urgent_max_recipients: { min: 1, max: 200 },
} as const

type CountField = keyof typeof RANGES

/** What each typed number is called, so an error message names the field. */
const COUNT_LABELS: Record<CountField, string> = {
  batch_size: 'How many people hear at once',
  max_offers_per_entry: 'Offers before someone comes off the list',
  urgent_max_recipients: 'Most people one late slot goes to',
}

interface Preset {
  value: number
  label: string
}

/**
 * Durations are offered as phrases and counts as numbers. A studio decides "two
 * hours", not "120"; it does decide "three people". Every preset below sits
 * inside its column's CHECK, which is what lets the selects skip validation.
 */
const CLAIM_WINDOW_PRESETS: Preset[] = [
  { value: 5, label: 'Five minutes' },
  { value: 15, label: 'Fifteen minutes' },
  { value: 30, label: 'Half an hour' },
  { value: 60, label: 'One hour' },
  { value: 120, label: 'Two hours' },
  { value: 240, label: 'Four hours' },
  { value: 480, label: 'Eight hours' },
  { value: 720, label: 'Twelve hours' },
  { value: 1440, label: 'One day' },
  { value: 2880, label: 'Two days' },
  { value: 10080, label: 'Seven days' },
]

const URGENT_PRESETS: Preset[] = [
  { value: 0, label: 'Never — everything goes through the queue' },
  { value: 2, label: 'Two hours' },
  { value: 4, label: 'Four hours' },
  { value: 6, label: 'Six hours' },
  { value: 12, label: 'Twelve hours' },
  { value: 24, label: 'One day' },
  { value: 48, label: 'Two days' },
  { value: 72, label: 'Three days' },
]

const EXPIRY_PRESETS: Preset[] = [
  { value: 7, label: 'One week' },
  { value: 14, label: 'Two weeks' },
  { value: 30, label: 'One month' },
  { value: 60, label: 'Two months' },
  { value: 90, label: 'Three months' },
  { value: 180, label: 'Six months' },
  { value: 365, label: 'One year' },
]

/**
 * The presets plus whatever is actually stored, if that is not one of them.
 *
 * Somebody set these in SQL before this page existed, and a select that quietly
 * drops the saved value would rewrite it the first time anything else on the
 * form was saved. Anchored on the stored value rather than the draft so the
 * extra option does not disappear mid-edit.
 */
function withStored(presets: Preset[], stored: number, unit: string): Preset[] {
  if (presets.some((p) => p.value === stored)) return presets
  return [...presets, { value: stored, label: `${stored} ${unit}` }].sort(
    (a, b) => a.value - b.value
  )
}

/** How a duration reads in a sentence. */
function phraseFor(presets: Preset[], value: number, unit: string): string {
  const hit = presets.find((p) => p.value === value)
  return hit ? hit.label.toLowerCase() : `${value} ${unit}`
}

type Draft = {
  auto_notify: boolean
  batch_size: string
  claim_window_minutes: string
  urgent_within_hours: string
  max_offers_per_entry: string
  default_expiry_days: string
  urgent_max_recipients: string
}

function draftFrom(settings: WaitlistSettings): Draft {
  return {
    auto_notify: settings.auto_notify,
    batch_size: String(settings.batch_size),
    claim_window_minutes: String(settings.claim_window_minutes),
    urgent_within_hours: String(settings.urgent_within_hours),
    max_offers_per_entry: String(settings.max_offers_per_entry),
    default_expiry_days: String(settings.default_expiry_days),
    urgent_max_recipients: String(settings.urgent_max_recipients),
  }
}

/** A typed count, or the saved one while the field is empty or half-written. */
function countOr(raw: string, fallback: number): number {
  const n = Number(raw)
  return raw.trim() !== '' && Number.isInteger(n) && n > 0 ? n : fallback
}

/** The typed numbers, checked against the same bounds the database enforces. */
function problemWith(draft: Draft): string | null {
  for (const field of Object.keys(RANGES) as CountField[]) {
    const { min, max } = RANGES[field]
    const n = Number(draft[field])
    if (!Number.isInteger(n) || n < min || n > max) {
      return `${COUNT_LABELS[field]} has to be a whole number between ${min} and ${max}.`
    }
  }
  return null
}

/**
 * The waitlist rules — admin only, because 037 makes `waitlist_settings`
 * staff-readable and admin-writable.
 *
 * Every sentence here describes what the SQL in 037 actually does, not what the
 * column is called. Where a setting has a cost as well as a benefit, the cost is
 * stated: these are not preferences, they decide who is told about a cancelled
 * appointment and who is left waiting for the next one.
 */
export function WaitlistRulesForm({ settings }: { settings: WaitlistSettings }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<Draft>(draftFrom(settings))

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  // Derived during render — never synced in an effect. The React Compiler lint
  // in this project rejects that, and there is nothing here it could not work
  // out from the draft it already has.
  const claimOptions = withStored(
    CLAIM_WINDOW_PRESETS,
    settings.claim_window_minutes,
    'minutes'
  )
  const urgentOptions = withStored(URGENT_PRESETS, settings.urgent_within_hours, 'hours')
  const expiryOptions = withStored(EXPIRY_PRESETS, settings.default_expiry_days, 'days')

  // A half-typed count reads as 0 through `Number('')`, which would make the
  // summary below say something false while someone is still typing. The two
  // selects cannot be mid-edit, so only the typed fields need the guard.
  const batch = countOr(draft.batch_size, settings.batch_size)
  const urgentCap = countOr(draft.urgent_max_recipients, settings.urgent_max_recipients)
  const claimMinutes = Number(draft.claim_window_minutes)
  const urgentHours = Number(draft.urgent_within_hours)

  const saved = draftFrom(settings)
  const dirty = (Object.keys(saved) as (keyof Draft)[]).some((k) => saved[k] !== draft[k])

  async function save(e: React.FormEvent) {
    e.preventDefault()

    const problem = problemWith(draft)
    if (problem) {
      toast.error(problem)
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('waitlist_settings')
      .update({
        auto_notify: draft.auto_notify,
        batch_size: Number(draft.batch_size),
        claim_window_minutes: Number(draft.claim_window_minutes),
        urgent_within_hours: Number(draft.urgent_within_hours),
        max_offers_per_entry: Number(draft.max_offers_per_entry),
        default_expiry_days: Number(draft.default_expiry_days),
        urgent_max_recipients: Number(draft.urgent_max_recipients),
      })
      .eq('id', 1)
    setBusy(false)

    if (error) {
      // 23514 is a CHECK the form failed to mirror — worth saying plainly rather
      // than as "something went wrong", because it means this file is out of
      // step with 037.
      toast.error(
        error.code === '23514'
          ? 'The database refused one of those values. Check the allowed range on each field.'
          : error.message || 'Could not save those rules.'
      )
      return
    }

    toast.success('Saved. The next cancellation follows these rules.')
    router.refresh()
  }

  return (
    <form
      onSubmit={save}
      className="space-y-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
    >
      <p className="max-w-prose border-l-2 border-[var(--color-accent)] pl-3 text-sm text-[var(--color-muted)]">
        As it stands:{' '}
        {urgentHours === 0 ? (
          <>every cancellation, however late it comes in, goes to </>
        ) : (
          <>
            a cancellation more than{' '}
            <span className="text-[var(--color-foreground)]">
              {phraseFor(urgentOptions, urgentHours, 'hours')}
            </span>{' '}
            away goes to{' '}
          </>
        )}
        <span className="text-[var(--color-foreground)]">
          {batch === 1 ? 'the one person who has waited longest' : `${batch} people`}
        </span>
        , held for{' '}
        <span className="text-[var(--color-foreground)]">
          {phraseFor(claimOptions, claimMinutes, 'minutes')}
        </span>{' '}
        before anyone behind them hears.
        {urgentHours > 0 && (
          <>
            {' '}
            Closer in than that, up to{' '}
            <span className="text-[var(--color-foreground)]">{urgentCap} people</span> are
            told at once.
          </>
        )}
      </p>

      <section className="space-y-5">
        <div>
          <h3 className="display text-xl">Who is told, and when</h3>
          <p className="mt-1.5 max-w-prose text-sm text-[var(--color-muted)]">
            Nothing here reserves the appointment. It is a hold on being{' '}
            <em>told</em>, not on the time — the slot stays bookable by anyone who finds
            it on the website, which is why holding it for one person for a week is worse
            than it sounds.
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={draft.auto_notify}
            onChange={(e) => set({ auto_notify: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Offer a freed slot the moment the booking is cancelled
            <span className="block text-[var(--color-muted)]">
              On, cancelling a booking sends the offer there and then. Off, nothing goes
              out at the moment of cancellation.
            </span>
          </span>
        </label>

        {!draft.auto_notify && (
          <p className="max-w-prose border-l-2 border-amber-500 pl-3 text-xs leading-relaxed text-[var(--color-muted)]">
            Off is a delay, not silence. The ten-minute job picks up every future booking
            cancelled in the last seven days and offers it anyway — it does not read this
            switch. Turning this off buys roughly ten minutes to catch a cancellation
            before the list hears about it; it does not put every offer in a person&rsquo;s
            hands.
          </p>
        )}

        <Field
          label="How many people hear at once"
          htmlFor="wl-batch"
          hint="One at a time is strict first come, first served: the person who has waited longest gets it to themselves. A higher number fills the chair sooner and tells several people about a slot only one of them can have. Anyone already holding this slot counts towards the number, so it is not re-offered on every pass. Whole number, 1 to 50."
        >
          <Input
            id="wl-batch"
            type="number"
            inputMode="numeric"
            min={RANGES.batch_size.min}
            max={RANGES.batch_size.max}
            step={1}
            required
            value={draft.batch_size}
            onChange={(e) => set({ batch_size: e.target.value })}
          />
        </Field>

        <Field
          label="How long the front of the queue keeps it to themselves"
          htmlFor="wl-claim"
          hint="Nobody behind them is told until this runs out. A hold is cut short at the appointment's own start time, so a two-hour window on a slot ninety minutes away holds it for ninety minutes. When it lapses they go back to waiting and keep their place — they are not sent to the back."
        >
          <Select
            id="wl-claim"
            value={draft.claim_window_minutes}
            onChange={(e) => set({ claim_window_minutes: e.target.value })}
          >
            {claimOptions.map((o) => (
              <option key={o.value} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </section>

      <section className="space-y-5 border-t border-[var(--color-border)] pt-8">
        <div>
          <h3 className="display text-xl">When there is no time to queue</h3>
          <p className="mt-1.5 max-w-prose text-sm text-[var(--color-muted)]">
            A slot at four this afternoon that nobody claims by two is simply a slot the
            studio did not sell. Close enough in, fairness loses to filling the chair.
          </p>
        </div>

        <Field
          label="Treat a cancellation as urgent inside"
          htmlFor="wl-urgent"
          hint="Everyone matching is told at once instead of one at a time, up to the cap below. Set it to never and every cancellation goes through the queue, however late it comes in."
        >
          <Select
            id="wl-urgent"
            value={draft.urgent_within_hours}
            onChange={(e) => set({ urgent_within_hours: e.target.value })}
          >
            {urgentOptions.map((o) => (
              <option key={o.value} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Most people one late slot goes to"
          htmlFor="wl-urgent-cap"
          hint="The ceiling on the line above, so one late cancellation cannot turn into a hundred message threads. Taken in order of who has waited longest. It applies only to urgent slots — an ordinary cancellation is limited by the number at the top of this page. Whole number, 1 to 200."
        >
          <Input
            id="wl-urgent-cap"
            type="number"
            inputMode="numeric"
            min={RANGES.urgent_max_recipients.min}
            max={RANGES.urgent_max_recipients.max}
            step={1}
            required
            value={draft.urgent_max_recipients}
            onChange={(e) => set({ urgent_max_recipients: e.target.value })}
          />
        </Field>
      </section>

      <section className="space-y-5 border-t border-[var(--color-border)] pt-8">
        <div>
          <h3 className="display text-xl">When someone comes off the list</h3>
          <p className="mt-1.5 max-w-prose text-sm text-[var(--color-muted)]">
            Nothing is deleted. An entry that runs out is marked expired, stops matching,
            and stays on the client&rsquo;s record.
          </p>
        </div>

        <Field
          label="Offers before someone comes off the list"
          htmlFor="wl-offers"
          hint="Every offer counts, answered or not. On the last one the entry is closed rather than asked again — someone who has let three slots go by is not waiting for one. Raising this later does not reopen entries that already closed. Whole number, 1 to 20."
        >
          <Input
            id="wl-offers"
            type="number"
            inputMode="numeric"
            min={RANGES.max_offers_per_entry.min}
            max={RANGES.max_offers_per_entry.max}
            step={1}
            required
            value={draft.max_offers_per_entry}
            onChange={(e) => set({ max_offers_per_entry: e.target.value })}
          />
        </Field>

        <Field
          label="How long a request stays live"
          htmlFor="wl-expiry"
          hint="Stamped on the entry at the moment someone joins the list. Changing it moves nothing already on the list — only requests made after you save. An entry also closes on its own once the last date the client asked for has passed, whichever comes first."
        >
          <Select
            id="wl-expiry"
            value={draft.default_expiry_days}
            onChange={(e) => set({ default_expiry_days: e.target.value })}
          >
            {expiryOptions.map((o) => (
              <option key={o.value} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </section>

      <Button type="submit" disabled={busy || !dirty}>
        {busy ? 'Saving…' : 'Save rules'}
      </Button>
    </form>
  )
}
