import * as React from 'react'
import { cn } from '@/lib/utils'

/** Page-width container. One place to change the editorial measure. */
export function Container({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mx-auto w-full max-w-6xl px-6 lg:px-10', className)} {...props} />
}

export function Section({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  // 5rem of air above the fold eats a whole phone screen; the editorial
  // spacing starts at sm and builds from there.
  return <section className={cn('py-12 sm:py-20 lg:py-28', className)} {...props} />
}

/** The uppercase eyebrow + serif heading pair used at the top of each section. */
export function SectionHeading({
  eyebrow,
  title,
  lede,
  align = 'left',
  className,
}: {
  eyebrow?: string
  title: string
  lede?: string
  align?: 'left' | 'center'
  className?: string
}) {
  return (
    <div
      className={cn(
        'max-w-2xl',
        align === 'center' && 'mx-auto text-center',
        className
      )}
    >
      {eyebrow && (
        <p className="label-caps mb-4 text-[var(--color-accent)]">{eyebrow}</p>
      )}
      <h2 className="display text-3xl sm:text-4xl lg:text-[2.75rem]">{title}</h2>
      {lede && (
        <p className="mt-5 text-base leading-relaxed text-[var(--color-muted)]">{lede}</p>
      )}
    </div>
  )
}
