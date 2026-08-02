'use client'

import { useRef } from 'react'
import { MapPin } from 'lucide-react'
import { ALL_LOCATIONS_LABEL } from '@/types/locations'

/**
 * The control itself. Submits on change so switching studios is one gesture,
 * and keeps a real submit button — hidden, but reachable by keyboard and by
 * anyone whose JavaScript has not loaded yet — so the choice is never trapped
 * behind an event handler.
 */
export function LocationSwitcherSelect({
  options,
  current,
  action,
}: {
  options: { id: number; name: string }[]
  /** The chosen location id, or 'all'. */
  current: string
  action: (formData: FormData) => Promise<void>
}) {
  const form = useRef<HTMLFormElement>(null)

  return (
    <form
      ref={form}
      action={action}
      className="flex items-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
    >
      <MapPin
        className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]"
        strokeWidth={1.5}
        aria-hidden
      />
      <label htmlFor="location-scope" className="sr-only">
        Showing which location
      </label>
      <select
        id="location-scope"
        name="location"
        defaultValue={current}
        onChange={() => form.current?.requestSubmit()}
        className="label-caps min-h-9 max-w-40 cursor-pointer truncate bg-transparent py-1 pr-1 text-[var(--color-foreground)] focus:outline-none"
      >
        <option value="all">{ALL_LOCATIONS_LABEL}</option>
        {options.map((o) => (
          <option key={o.id} value={String(o.id)}>
            {o.name}
          </option>
        ))}
      </select>
      <button type="submit" className="sr-only">
        Switch location
      </button>
    </form>
  )
}
