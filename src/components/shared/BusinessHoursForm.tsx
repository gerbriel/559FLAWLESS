'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

export interface BusinessHourRow {
  /** The primary key — business_hours has one row per weekday and no id. */
  day_of_week: number
  opens_at: string | null
  closes_at: string | null
  is_closed: boolean
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "09:00:00" → "09:00", which is what <input type="time"> wants. */
const toInput = (t: string | null) => (t ? t.slice(0, 5) : '')

/**
 * The opening hours shown in the site footer.
 *
 * These are display only — what the studio tells the public. They do not
 * generate bookable slots; that is `provider_schedules` under My hours, which
 * is a separate thing on purpose. A provider can be taking appointments at 8am
 * for a regular without the front page claiming the studio opens then.
 */
export function BusinessHoursForm({ hours }: { hours: BusinessHourRow[] }) {
  const router = useRouter()
  const [rows, setRows] = useState(
    // Sunday-first, so it reads like a calendar rather than database order.
    [...hours].sort((a, b) => a.day_of_week - b.day_of_week)
  )
  const [busy, setBusy] = useState(false)

  function update(day: number, patch: Partial<BusinessHourRow>) {
    setRows((cur) => cur.map((r) => (r.day_of_week === day ? { ...r, ...patch } : r)))
  }

  async function save() {
    for (const r of rows) {
      if (!r.is_closed && (!r.opens_at || !r.closes_at)) {
        toast.error(`${DAYS[r.day_of_week]} needs an opening and closing time, or mark it closed.`)
        return
      }
      if (!r.is_closed && r.opens_at! >= r.closes_at!) {
        toast.error(`${DAYS[r.day_of_week]} closes before it opens.`)
        return
      }
    }

    setBusy(true)
    const supabase = createClient()

    // One statement per row: only seven of them, and a failure part-way leaves
    // the rest correct rather than rolling back a whole week of edits.
    const results = await Promise.all(
      rows.map((r) =>
        supabase
          .from('business_hours')
          .update({
            opens_at: r.is_closed ? null : r.opens_at,
            closes_at: r.is_closed ? null : r.closes_at,
            is_closed: r.is_closed,
          })
          .eq('day_of_week', r.day_of_week)
      )
    )
    setBusy(false)

    const failed = results.filter((res) => res.error)
    if (failed.length) {
      toast.error('Could not save some days. Please try again.')
      return
    }

    toast.success('Hours updated.')
    router.refresh()
  }

  return (
    <div>
      <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
        {rows.map((r) => (
          <li key={r.day_of_week} className="flex flex-wrap items-center gap-x-4 gap-y-3 py-3">
            <span className="w-24 shrink-0 text-sm">{DAYS[r.day_of_week]}</span>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={r.is_closed}
                onChange={(e) => update(r.day_of_week, { is_closed: e.target.checked })}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Closed
            </label>

            {!r.is_closed && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`open_${r.day_of_week}`}>
                  {DAYS[r.day_of_week]} opens
                </label>
                <input
                  id={`open_${r.day_of_week}`}
                  type="time"
                  value={toInput(r.opens_at)}
                  onChange={(e) => update(r.day_of_week, { opens_at: e.target.value })}
                  className="min-h-11 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)]"
                />
                <span className="text-[var(--color-muted)]">to</span>
                <label className="sr-only" htmlFor={`close_${r.day_of_week}`}>
                  {DAYS[r.day_of_week]} closes
                </label>
                <input
                  id={`close_${r.day_of_week}`}
                  type="time"
                  value={toInput(r.closes_at)}
                  onChange={(e) => update(r.day_of_week, { closes_at: e.target.value })}
                  className="min-h-11 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)]"
                />
              </div>
            )}
          </li>
        ))}
      </ul>

      <Button className="mt-5" size="sm" onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save hours'}
      </Button>

      <p className="mt-3 max-w-prose text-xs text-[var(--color-muted)]">
        These appear in the site footer. They do not decide what is bookable — that comes
        from each provider&rsquo;s own hours, so you can take an early appointment without
        the front page claiming you open then.
      </p>
    </div>
  )
}
