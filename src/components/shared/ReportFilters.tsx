'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Label, Select, Input } from '@/components/ui/field'
import {
  DATE_RANGE_PRESETS,
  resolveDateRange,
  type DateRangePreset,
  type ReportFilter,
} from '@/lib/reports/types'

interface Props {
  filters: readonly ReportFilter[]
  preset: DateRangePreset
  from: string
  to: string
  timeZone: string
  /** Active sites. One or none and the location control is not rendered at all. */
  locations: { id: number; name: string }[]
  locationId: number | null
  providers: { id: string; name: string }[]
  providerId: string | null
  /**
   * Params this form must carry through untouched.
   *
   * The custom builder puts its definition here: two GET forms on one page each
   * have to preserve the other's state, or changing the date range would
   * silently reset the columns someone just picked.
   */
  hidden?: Record<string, string | string[] | undefined>
}

/**
 * The filter bar every report shares.
 *
 * A plain GET form, so the result is a URL: linkable, refresh-safe, and
 * bookmarkable, which is the entire reason a manager can send someone "last
 * quarter at the Shaw studio" instead of a screenshot. It works with JavaScript
 * off; the script only makes the two date fields and the preset agree.
 *
 * Only the controls a module declared in `filters` are rendered. A report that
 * does not vary by provider does not get a provider dropdown that changes
 * nothing.
 */
export function ReportFilters({
  filters,
  preset,
  from,
  to,
  timeZone,
  locations,
  locationId,
  providers,
  providerId,
  hidden,
}: Props) {
  const pathname = usePathname()
  const [current, setCurrent] = useState<DateRangePreset>(preset)
  const [start, setStart] = useState(from)
  const [end, setEnd] = useState(to)

  const wants = new Set(filters)
  const isCustom = current === 'custom'

  // Only render the location control for a business that has more than one
  // site. A single-room studio must never be asked which room it means.
  const showLocation = wants.has('location') && locations.length > 1
  const showProvider = wants.has('provider') && providers.length > 0
  const showDates = wants.has('dateRange')

  if (!showDates && !showLocation && !showProvider) return null

  function choosePreset(value: DateRangePreset) {
    setCurrent(value)
    if (value === 'custom') return
    // Show the window the preset actually means, rather than leaving the last
    // custom dates sitting there contradicting the dropdown.
    const next = resolveDateRange(value, timeZone, Date.now())
    setStart(next.from)
    setEnd(next.to)
  }

  return (
    <form
      method="get"
      action={pathname}
      className="mt-8 flex flex-wrap items-end gap-x-4 gap-y-3 border-y border-[var(--color-border)] py-5"
    >
      {Object.entries(hidden ?? {}).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((v, i) => (
          <input key={`${name}-${i}`} type="hidden" name={name} value={v} />
        ))
      )}

      {showDates && (
        <>
          <div className="w-44">
            <Label htmlFor="report-preset">Period</Label>
            <Select
              id="report-preset"
              name="preset"
              value={current}
              onChange={(e) => choosePreset(e.target.value as DateRangePreset)}
            >
              {DATE_RANGE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="w-40">
            <Label htmlFor="report-from">From</Label>
            <Input
              id="report-from"
              type="date"
              // Unnamed inputs are not submitted, so a preset window never
              // carries stale explicit dates along in the URL.
              name={isCustom ? 'from' : undefined}
              value={start}
              onChange={(e) => {
                setStart(e.target.value)
                setCurrent('custom')
              }}
            />
          </div>

          <div className="w-40">
            <Label htmlFor="report-to">To</Label>
            <Input
              id="report-to"
              type="date"
              name={isCustom ? 'to' : undefined}
              value={end}
              onChange={(e) => {
                setEnd(e.target.value)
                setCurrent('custom')
              }}
            />
          </div>
        </>
      )}

      {showLocation && (
        <div className="w-52">
          <Label htmlFor="report-location">Location</Label>
          <Select id="report-location" name="location" defaultValue={locationId ?? ''}>
            <option value="">All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {showProvider && (
        <div className="w-52">
          <Label htmlFor="report-provider">Provider</Label>
          <Select id="report-provider" name="provider" defaultValue={providerId ?? ''}>
            <option value="">Everyone</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      <Button type="submit" variant="subtle" size="sm" className="mb-0.5">
        Apply
      </Button>
    </form>
  )
}
