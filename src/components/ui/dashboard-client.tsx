'use client'

import * as React from 'react'
import { Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The interactive half of the dashboard kit — the pieces that need a handler.
 * Split from `dashboard.tsx` so a server page can lay out a screen without
 * dragging a client boundary along with it.
 */

export interface PillOption {
  value: string
  label: string
  /** Shown after the label, the way "All (39)" reads in the reference. */
  count?: number
}

/**
 * The row of pills a list filters itself with. A radiogroup rather than a set
 * of buttons: arrow keys move between them, which is what a keyboard user
 * expects of something that behaves like one control.
 */
export function FilterPills({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: PillOption[]
  value: string
  onChange: (value: string) => void
  label: string
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('flex flex-wrap gap-2', className)}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex min-h-9 items-center gap-1.5 rounded-full border px-4 text-sm transition-colors',
              active
                ? 'border-[var(--color-foreground)] bg-[var(--color-foreground)] text-[var(--color-background)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] hover:border-[var(--color-accent)]'
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className={cn('tabular-nums', !active && 'text-[var(--color-muted)]')}>
                ({option.count})
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Minus, the number, plus.
 *
 * The number is an input, not a label: correcting a count of 40 to 12 by
 * tapping minus twenty-eight times is not a thing anyone should be asked to
 * do. Empty is allowed while typing and settles back on blur, so clearing the
 * field to type a new figure does not fire a change to zero on the way.
 */
export function Stepper({
  value,
  onChange,
  min = 0,
  max,
  label,
  disabled,
  className,
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  label: string
  disabled?: boolean
  className?: string
}) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const clamp = (n: number) => Math.max(min, max === undefined ? n : Math.min(max, n))

  const step =
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] transition-colors hover:border-[var(--color-accent)] disabled:opacity-30 disabled:hover:border-[var(--color-border)]'

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <button
        type="button"
        onClick={() => onChange(clamp(value - 1))}
        disabled={disabled || value <= min}
        className={step}
      >
        <Minus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        <span className="sr-only">One fewer {label}</span>
      </button>

      <input
        type="text"
        inputMode="numeric"
        value={draft ?? String(value)}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const next = e.target.value.replace(/[^0-9]/g, '')
          setDraft(next)
          if (next !== '') onChange(clamp(Number(next)))
        }}
        onBlur={() => setDraft(null)}
        className="h-9 w-12 rounded-[var(--radius-control)] border border-transparent bg-transparent text-center text-sm tabular-nums outline-none focus:border-[var(--color-accent)]"
      />

      <button
        type="button"
        onClick={() => onChange(clamp(value + 1))}
        disabled={disabled || (max !== undefined && value >= max)}
        className={step}
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        <span className="sr-only">One more {label}</span>
      </button>
    </div>
  )
}
