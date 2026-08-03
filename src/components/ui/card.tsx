import * as React from 'react'
import { cn } from '@/lib/utils'

// data-ui rounds this inside the dashboard's `.dash` scope and leaves it square
// on the storefront — one attribute, so a Card used on a staff screen matches
// the Panels around it without every caller opting in.
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-ui="panel"
      className={cn(
        'border border-[var(--color-border)] bg-[var(--color-surface)]',
        className
      )}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-6 pt-6 pb-3', className)} {...props} />
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn('font-[family-name:var(--font-display)] text-xl', className)}
      {...props}
    />
  )
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mt-1 text-sm text-[var(--color-muted)]', className)} {...props} />
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-6 pb-6', className)} {...props} />
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center gap-3 border-t border-[var(--color-border)] px-6 py-4', className)}
      {...props}
    />
  )
}
