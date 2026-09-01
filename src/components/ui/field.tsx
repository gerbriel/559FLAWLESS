import * as React from 'react'
import { cn } from '@/lib/utils'

// min-h-11 keeps every input a comfortable touch target; text-base stops
// iOS Safari zooming the viewport when a field is focused (it does that for
// anything under 16px).
// min-w-0 matters on phones: a select's intrinsic width is its longest
// option, and inside a grid column that forced the whole page wider than the
// screen — "things getting cut off" on the intake and onboarding forms.
const control =
  'w-full min-w-0 max-w-full min-h-11 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-base sm:text-sm ' +
  'text-[var(--color-foreground)] placeholder:text-[var(--color-muted)] ' +
  'focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50'

// data-ui rounds these inside the dashboard and leaves them square on the
// storefront — see the `.dash` scope in globals.css.
export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} data-ui="input" className={cn(control, className)} {...props} />
  }
)

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        data-ui="input"
        className={cn(control, 'min-h-24 resize-y', className)}
        {...props}
      />
    )
  }
)

export const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<'select'>>(
  function Select({ className, ...props }, ref) {
    return <select ref={ref} data-ui="input" className={cn(control, 'pr-8', className)} {...props} />
  }
)

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      className={cn('label-caps mb-2 block text-[var(--color-muted)]', className)}
      {...props}
    />
  )
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: string
  hint?: string
  error?: string
  htmlFor?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error && <p className="mt-1.5 text-xs text-[var(--color-muted)]">{hint}</p>}
      {error && <p className="mt-1.5 text-xs text-red-700 dark:text-red-400">{error}</p>}
    </div>
  )
}
