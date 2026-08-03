import * as React from 'react'
import Link from 'next/link'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors ' +
    'disabled:pointer-events-none disabled:opacity-45 label-caps',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--color-foreground)] text-[var(--color-background)] hover:bg-[var(--color-clay-deep)]',
        accent:
          'bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-clay-deep)]',
        outline:
          'border border-[var(--color-foreground)] text-[var(--color-foreground)] hover:bg-[var(--color-foreground)] hover:text-[var(--color-background)]',
        subtle:
          'border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] hover:border-[var(--color-accent)]',
        ghost:
          'text-[var(--color-foreground)] hover:text-[var(--color-accent)]',
        danger: 'bg-red-700 text-white hover:bg-red-800',
      },
      size: {
        sm: 'h-11 px-4 sm:h-9',
        md: 'h-11 px-7',
        lg: 'h-14 px-10',
        icon: 'h-11 w-11 px-0 sm:h-9 sm:w-9',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
)

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>

// data-ui is how the dashboard rounds its controls without the storefront
// hearing about it — see the `.dash` scope in globals.css. Set before the
// spread so a caller can still override it.
export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button data-ui="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
}

type ButtonLinkProps = React.ComponentProps<typeof Link> &
  VariantProps<typeof buttonVariants>

export function ButtonLink({ className, variant, size, ...props }: ButtonLinkProps) {
  return (
    <Link data-ui="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
}

export { buttonVariants }
