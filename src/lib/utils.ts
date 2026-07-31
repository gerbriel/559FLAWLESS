import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Money is stored in cents everywhere. Never do float math on prices. */
export function formatMoney(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  })
}

/**
 * How a service's price reads on the menu.
 *
 * A price of 0 is not free — it means the studio quotes it after seeing the
 * skin, which is the honest answer for lightening protocols that are built per
 * client. `formatMoney(0)` would render "$0" and promise something untrue.
 */
export function formatServicePrice(service: {
  price_cents: number
  price_is_starting: boolean
  requires_consultation?: boolean
}): string {
  if (service.price_cents <= 0) return 'At consultation'
  return service.price_is_starting
    ? `from ${formatMoney(service.price_cents)}`
    : formatMoney(service.price_cents)
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`
}

/** Slugify a service or product name for URLs. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export function initials(first?: string | null, last?: string | null): string {
  return `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase() || '?'
}
