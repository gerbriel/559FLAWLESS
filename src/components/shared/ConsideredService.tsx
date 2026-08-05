'use client'

import { useMemo, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { Container } from '@/components/ui/section'
import {
  consideredSnapshot,
  dismissConsidered,
  emptyConsideredSnapshot,
  readConsideredDisplay,
  subscribeConsidered,
} from '@/lib/interest'

/**
 * The quiet "still considering?" strip on the home page.
 *
 * Renders inside a STATIC page, so its server HTML must be stable: the store
 * read goes through useSyncExternalStore with a server snapshot of null —
 * nothing in the server HTML, the real answer in the first client render, no
 * effect and no setState (the same shape as SiteHeader's CartButton, and for
 * the same reason).
 *
 * Every rule about whether there is anything to show — absent, stale,
 * dismissed, consent withdrawn, and above all intimate — lives in
 * `consideredSnapshot` in src/lib/interest.ts, not here. This component only
 * knows how to say the sentence; it is structurally unable to name a service
 * the reader refused to hand it.
 */
export function ConsideredService() {
  const raw = useSyncExternalStore(
    subscribeConsidered,
    consideredSnapshot,
    emptyConsideredSnapshot
  )
  const considered = useMemo(() => (raw ? readConsideredDisplay(raw) : null), [raw])

  if (!considered) return null

  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-linen)] dark:bg-[var(--color-surface)]">
      <Container className="flex items-center justify-between gap-4 py-2">
        <p className="py-2 text-sm">
          Still considering the {considered.name}?{' '}
          <Link
            href={`/book?service=${considered.slug}`}
            className="label-caps whitespace-nowrap border-b border-[var(--color-foreground)] pb-0.5 transition-colors hover:text-[var(--color-accent)]"
          >
            Pick a time
          </Link>
        </p>
        <button
          type="button"
          onClick={dismissConsidered}
          aria-label="Dismiss"
          className="flex h-11 w-11 shrink-0 items-center justify-center text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)]"
        >
          <X className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </Container>
    </div>
  )
}
