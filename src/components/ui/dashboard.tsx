import * as React from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Search, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The dashboard's shared furniture.
 *
 * Every staff screen is the same four or five moves — a titled page with
 * actions in the corner, a panel, a row of tiles, a table with a thumbnail at
 * the left, and something to say when there is nothing yet. They were being
 * rewritten per page, which is why no two of them agreed on padding.
 *
 * The corners come from the `.dash` scope in globals.css rather than from
 * literals here, so the softness is one edit and not forty. Nothing in this
 * file reads from the database or holds state: it is layout, and it composes
 * into both server and client components.
 *
 * Extend by composing, not by editing — a screen that needs something unusual
 * should build it in its own file.
 */

/* ── The page itself ──────────────────────────────────────── */

/**
 * The top of a page: what it is, optionally a line about it, and the actions
 * that belong to the whole screen. Actions sit right on a wide window and
 * wrap under the title on a phone rather than squeezing it.
 */
export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
  className,
}: {
  eyebrow?: string
  title: string
  lede?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        {eyebrow && <p className="label-caps mb-2 text-[var(--color-accent)]">{eyebrow}</p>}
        <h1 className="display text-3xl">{title}</h1>
        {lede && (
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">{lede}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </div>
  )
}

/** A rounded surface. The dashboard's Card. */
export function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
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

/**
 * The bar above a working surface — the calendar's date controls, a list's
 * filters. Sticky, because on the calendar it is how you move.
 */
export function Toolbar({
  left,
  right,
  className,
}: {
  left?: React.ReactNode
  right?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 py-2',
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5">{left}</div>
      <div className="flex flex-wrap items-center gap-2.5">{right}</div>
    </div>
  )
}

/* ── Saying what a screen is for ──────────────────────────── */

/**
 * The tinted panel at the top of a feature someone has not set up yet: what it
 * is, in a sentence, and the two things they might do about it. Optional
 * artwork on the right, hidden on a phone where it would push the buttons off.
 */
export function HeroPanel({
  icon: Icon,
  title,
  lede,
  actions,
  image,
  className,
}: {
  icon?: LucideIcon
  title: string
  lede?: React.ReactNode
  actions?: React.ReactNode
  image?: { src: string; alt: string }
  className?: string
}) {
  return (
    <div
      data-ui="panel"
      className={cn(
        'grid gap-6 overflow-hidden bg-[var(--color-clay-soft)] dark:bg-[var(--color-surface)]',
        image ? 'lg:grid-cols-[1fr_20rem]' : '',
        className
      )}
    >
      <div className="p-8">
        {Icon && (
          <Icon
            className="mb-5 h-7 w-7 text-[var(--color-clay-deep)] dark:text-[var(--color-accent)]"
            strokeWidth={1.25}
            aria-hidden
          />
        )}
        <h2 className="display text-2xl">{title}</h2>
        {lede && (
          <p className="mt-3 max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
            {lede}
          </p>
        )}
        {actions && <div className="mt-6 flex flex-wrap items-center gap-2.5">{actions}</div>}
      </div>

      {image && (
        <div className="relative hidden min-h-48 lg:block">
          <Image src={image.src} alt={image.alt} fill sizes="20rem" className="object-cover" />
        </div>
      )}
    </div>
  )
}

/**
 * Three plain cards explaining what a screen does. Deliberately below the
 * fold's worth of real work — it is for the first week, not the hundredth day.
 */
export function HowItWorks({
  title = 'How it works',
  items,
  className,
}: {
  title?: string
  items: { icon: LucideIcon; title: string; body: React.ReactNode }[]
  className?: string
}) {
  return (
    <section className={className}>
      <h2 className="display text-2xl">{title}</h2>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <Panel key={item.title} className="p-6">
              <span
                data-ui="tile"
                className="mb-4 flex h-10 w-10 items-center justify-center bg-[var(--color-linen)] dark:bg-[var(--color-background)]"
              >
                <Icon className="h-4.5 w-4.5 text-[var(--color-muted)]" strokeWidth={1.5} aria-hidden />
              </span>
              <h3 className="text-base">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">{item.body}</p>
            </Panel>
          )
        })}
      </div>
    </section>
  )
}

/**
 * A big thing to go and do — the row of them above a marketing screen, the
 * grid of them on Reports. Renders as a link or a button depending on which
 * you hand it.
 */
export function ActionTile({
  icon: Icon,
  title,
  subtitle,
  href,
  badge,
  onClick,
  className,
}: {
  icon: LucideIcon
  title: string
  subtitle?: React.ReactNode
  href?: string
  badge?: React.ReactNode
  onClick?: () => void
  className?: string
}) {
  const inner = (
    <>
      <span
        data-ui="tile"
        className="flex h-10 w-10 shrink-0 items-center justify-center bg-[var(--color-clay-soft)] dark:bg-[var(--color-background)]"
      >
        <Icon
          className="h-4.5 w-4.5 text-[var(--color-clay-deep)] dark:text-[var(--color-accent)]"
          strokeWidth={1.5}
          aria-hidden
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="block text-base">{title}</span>
          {badge}
        </span>
        {subtitle && (
          <span className="mt-1 block text-sm text-[var(--color-muted)]">{subtitle}</span>
        )}
      </span>
    </>
  )

  const shell = cn(
    'flex w-full items-start gap-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-left transition-colors hover:border-[var(--color-accent)]',
    className
  )

  if (href) {
    return (
      <Link href={href} data-ui="panel" className={shell}>
        {inner}
      </Link>
    )
  }

  return (
    <button type="button" onClick={onClick} data-ui="panel" className={shell}>
      {inner}
    </button>
  )
}

/**
 * Nothing here yet — and, more usefully, what to do about it. The dashed edge
 * is the tell that this is a space waiting to be filled rather than a panel
 * that happens to be short.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-ui="panel"
      className={cn(
        'flex flex-col items-center border border-dashed border-[var(--color-border)] px-6 py-16 text-center',
        className
      )}
    >
      {Icon && (
        <span
          data-ui="tile"
          className="mb-5 flex h-12 w-12 items-center justify-center bg-[var(--color-linen)] dark:bg-[var(--color-surface)]"
        >
          <Icon className="h-5 w-5 text-[var(--color-muted)]" strokeWidth={1.5} aria-hidden />
        </span>
      )}
      <h3 className="text-base">{title}</h3>
      {description && (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-[var(--color-muted)]">
          {description}
        </p>
      )}
      {action && <div className="mt-6 flex flex-wrap justify-center gap-2.5">{action}</div>}
    </div>
  )
}

/** One number worth reading across a room. */
export function StatTile({
  label,
  value,
  hint,
  className,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  className?: string
}) {
  return (
    <Panel className={cn('p-5', className)}>
      <p className="label-caps text-[var(--color-muted)]">{label}</p>
      <p className="display mt-2 text-3xl tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-[var(--color-muted)]">{hint}</p>}
    </Panel>
  )
}

/* ── Row furniture ────────────────────────────────────────── */

/** First initial, or first and last. "Ade" → A. "Amy Siphonthong" → AS. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  const first = Array.from(parts[0])[0] ?? ''
  if (parts.length === 1) return first.toUpperCase()
  const last = Array.from(parts[parts.length - 1])[0] ?? ''
  return (first + last).toUpperCase()
}

/**
 * A person, at the left of their row. No photographs anywhere in the CRM —
 * clients did not upload one, and a face next to clinical notes is a
 * different decision than this component gets to make.
 */
export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <span
      data-ui="tile"
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center bg-[var(--color-clay-soft)] font-medium text-[var(--color-clay-deep)] dark:bg-[var(--color-background)] dark:text-[var(--color-accent)]',
        size === 'sm' ? 'h-8 w-8 text-xs' : 'h-10 w-10 text-sm',
        className
      )}
    >
      {initialsOf(name)}
    </span>
  )
}

/**
 * A product or service at the left of its row: the photo if there is one, a
 * quiet icon if there is not. Square, contained, never cropped — the product
 * shots are transparent bottles on nothing.
 */
export function Thumb({
  src,
  alt = '',
  icon: Icon,
  size = 'md',
  className,
}: {
  src?: string | null
  alt?: string
  icon?: LucideIcon
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const box = size === 'sm' ? 'h-10 w-10' : size === 'lg' ? 'h-16 w-16' : 'h-12 w-12'
  const px = size === 'sm' ? '40px' : size === 'lg' ? '64px' : '48px'

  return (
    <span
      data-ui="tile"
      className={cn(
        'relative block shrink-0 overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-background)]',
        box,
        className
      )}
    >
      {src ? (
        <Image src={src} alt={alt} fill sizes={px} className="object-contain p-1.5" />
      ) : Icon ? (
        <Icon
          className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-[var(--color-muted)]"
          strokeWidth={1.25}
          aria-hidden
        />
      ) : null}
    </span>
  )
}

/**
 * A search box that looks like the reference's: the icon inside the field,
 * the field the width of the content it filters. Hook-free, so it works as a
 * GET form on a server page and as a controlled input in a client one.
 */
export function SearchField({
  label,
  className,
  ...props
}: React.ComponentProps<'input'> & { label: string }) {
  return (
    <label className={cn('relative block', className)}>
      <span className="sr-only">{label}</span>
      <Search
        className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]"
        strokeWidth={1.5}
        aria-hidden
      />
      <input
        type="search"
        data-ui="input"
        placeholder={label}
        className="min-h-11 w-full border border-[var(--color-border)] bg-[var(--color-surface)] py-2.5 pl-10 pr-3 text-base outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-accent)] sm:text-sm"
        {...props}
      />
    </label>
  )
}

/**
 * Page numbers, as links. A list that pages in the URL survives a refresh and
 * can be sent to someone, which is why this takes an href builder rather than
 * a callback.
 */
export function Pagination({
  page,
  pageCount,
  hrefFor,
  className,
}: {
  page: number
  pageCount: number
  hrefFor: (page: number) => string
  className?: string
}) {
  if (pageCount <= 1) return null

  // Long lists get an ellipsis rather than forty numbers: first, last, and a
  // window around where you are.
  const pages: (number | 'gap')[] = []
  for (let n = 1; n <= pageCount; n++) {
    if (n === 1 || n === pageCount || Math.abs(n - page) <= 1) {
      pages.push(n)
    } else if (pages[pages.length - 1] !== 'gap') {
      pages.push('gap')
    }
  }

  const step =
    'flex h-9 min-w-9 items-center justify-center px-2 text-sm tabular-nums transition-colors'

  return (
    <nav aria-label="Pages" className={cn('flex items-center justify-center gap-1.5', className)}>
      {page > 1 && (
        <Link href={hrefFor(page - 1)} rel="prev" className={cn(step, 'rounded-full text-[var(--color-muted)] hover:text-[var(--color-foreground)]')}>
          <span aria-hidden>‹</span>
          <span className="sr-only">Previous page</span>
        </Link>
      )}

      {pages.map((n, i) =>
        n === 'gap' ? (
          <span key={`gap-${i}`} className={cn(step, 'text-[var(--color-muted)]')} aria-hidden>
            …
          </span>
        ) : (
          <Link
            key={n}
            href={hrefFor(n)}
            aria-current={n === page ? 'page' : undefined}
            className={cn(
              step,
              'rounded-full',
              n === page
                ? 'bg-[var(--color-foreground)] text-[var(--color-background)]'
                : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
            )}
          >
            {n}
          </Link>
        )
      )}

      {page < pageCount && (
        <Link href={hrefFor(page + 1)} rel="next" className={cn(step, 'rounded-full text-[var(--color-muted)] hover:text-[var(--color-foreground)]')}>
          <span aria-hidden>›</span>
          <span className="sr-only">Next page</span>
        </Link>
      )}
    </nav>
  )
}
