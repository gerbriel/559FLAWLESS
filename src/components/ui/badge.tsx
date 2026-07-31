import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 border px-2.5 py-1 text-[0.6875rem] font-medium uppercase tracking-[0.12em]',
  {
    variants: {
      tone: {
        neutral:
          'border-[var(--color-border)] bg-[var(--color-linen)] text-[var(--color-muted)] dark:bg-transparent',
        accent: 'border-[var(--color-accent)] bg-[var(--color-clay-soft)] text-[var(--color-clay-deep)] dark:bg-transparent dark:text-[var(--color-accent)]',
        success: 'border-emerald-600/40 bg-emerald-50 text-emerald-800 dark:bg-transparent dark:text-emerald-400',
        warning: 'border-amber-600/40 bg-amber-50 text-amber-800 dark:bg-transparent dark:text-amber-400',
        danger: 'border-red-600/40 bg-red-50 text-red-800 dark:bg-transparent dark:text-red-400',
      },
    },
    defaultVariants: { tone: 'neutral' },
  }
)

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
