'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { X, ArrowRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { trackEvent } from '@/components/shared/AnalyticsTracker'
import { cn } from '@/lib/utils'
import {
  selectAnnouncements,
  pickPerStyle,
  readDismissed,
  recordDismissal,
  ANONYMOUS,
  type LiveAnnouncement,
  type Viewer,
} from '@/lib/announcements'
import type { UserRole } from '@/types/database'

/**
 * Renders whichever announcements apply to this page and this viewer.
 *
 * The server ships every live row (cacheable, no session needed) and the
 * filtering happens here, where the pathname and the session actually are.
 * Anonymous visitors — the common case — never wait on a network call: they
 * are treated as anonymous immediately and re-evaluated only if a session
 * turns out to exist.
 */
export function Announcements({ announcements }: { announcements: LiveAnnouncement[] }) {
  const pathname = usePathname()
  const [viewer, setViewer] = useState<Viewer>(ANONYMOUS)
  const [dismissed, setDismissed] = useState<number[]>([])
  const [hydrated, setHydrated] = useState(false)

  // Read the session and any prior dismissals once, after mount. Both are
  // browser-only, so this cannot run during render.
  useEffect(() => {
    let alive = true

    async function resolve() {
      setDismissed(readDismissed())

      const supabase = createClient()
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!alive) return
      if (!session?.user) {
        setHydrated(true)
        return
      }

      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle()

      if (!alive) return
      setViewer({ userId: session.user.id, role: (data?.role ?? 'client') as UserRole })
      setHydrated(true)
    }

    void resolve().catch(() => setHydrated(true))
    return () => {
      alive = false
    }
  }, [])

  const byStyle = useMemo(
    () =>
      pickPerStyle(
        selectAnnouncements(announcements, { pathname, viewer, dismissed })
      ),
    [announcements, pathname, viewer, dismissed]
  )

  function dismiss(a: LiveAnnouncement) {
    void trackEvent('announcement_dismiss', { announcement_id: String(a.id) })
    recordDismissal(a.id, a.dismiss_scope ?? 'session')
    setDismissed((d) => [...d, a.id])
  }

  // Whatever survived targeting is what is actually on screen, so that is what
  // counts as an impression.
  useImpression(
    useMemo(
      () => Object.values(byStyle).filter(Boolean).map((a) => (a as LiveAnnouncement).id),
      [byStyle]
    )
  )

  return (
    <>
      {byStyle.banner && <Banner a={byStyle.banner} onDismiss={dismiss} />}
      {byStyle.inline && <Inline a={byStyle.inline} onDismiss={dismiss} />}
      {/* Interruptive formats wait for the session check, so a modal aimed at
          signed-out visitors never flashes at someone who is signed in. */}
      {hydrated && byStyle.corner && <Corner a={byStyle.corner} onDismiss={dismiss} />}
      {hydrated && byStyle.modal && <Modal a={byStyle.modal} onDismiss={dismiss} />}
    </>
  )
}

// ── Shared bits ─────────────────────────────────────────────
type Props = { a: LiveAnnouncement; onDismiss: (a: LiveAnnouncement) => void }

const TONE: Record<string, string> = {
  info: 'bg-[var(--color-espresso)] text-[var(--color-porcelain)]',
  promo: 'bg-[var(--color-accent)] text-white',
  urgent: 'bg-red-800 text-white',
}

/**
 * Inline style for an announcement that overrides its template's colours.
 *
 * Returns undefined when nothing is overridden, so the Tailwind class keeps
 * working — including its dark-mode variants, which a hard-coded colour would
 * otherwise silently defeat.
 */
function customStyle(a: LiveAnnouncement): React.CSSProperties | undefined {
  if (!a.background_color && !a.text_color) return undefined
  return {
    ...(a.background_color ? { background: a.background_color } : {}),
    ...(a.text_color ? { color: a.text_color } : {}),
  }
}

/** Drop the template's colour classes when a custom one replaces them. */
function toneClass(a: LiveAnnouncement): string | undefined {
  if (a.background_color && a.text_color) return undefined
  return TONE[a.variant] ?? TONE.info
}

function Cta({ a, className }: { a: LiveAnnouncement; className?: string }) {
  if (!a.link_url) return null
  return (
    <Link
      href={a.link_url}
      onClick={() => void trackEvent('announcement_click', { announcement_id: String(a.id) })}
      className={cn('label-caps inline-flex items-center gap-1.5', className)}
    >
      {a.link_label ?? 'Learn more'}
      <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
    </Link>
  )
}

/**
 * Record that an announcement was actually on screen, once per session.
 *
 * Per session rather than per render: a header banner would otherwise log an
 * impression on every navigation and read as wildly successful for doing
 * nothing. `seen` is module-level so it survives re-renders and route changes
 * within the same page load.
 */
const seen = new Set<number>()

function useImpression(ids: number[]) {
  useEffect(() => {
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      void trackEvent('announcement_view', { announcement_id: String(id) })
    }
  }, [ids])
}

// ── Banner ──────────────────────────────────────────────────
function Banner({ a, onDismiss }: Props) {
  return (
    <div className={cn('relative', toneClass(a))} style={customStyle(a)}>
      {/* Right padding clears the close button so long text never runs under it. */}
      <div className="flex min-h-11 flex-wrap items-center justify-center gap-x-3 gap-y-0.5 py-2 pl-4 pr-14 text-center sm:pr-16">
        {a.image_url && (
          <span className="relative h-5 w-5 shrink-0 overflow-hidden">
            <Image src={a.image_url} alt="" fill sizes="20px" className="object-contain" />
          </span>
        )}
        <span className="label-caps">{a.title}</span>
        {/* py-2 gives the link a 40px-tall hit area without changing how it looks. */}
        <Cta a={a} className="-my-2 inline-flex min-h-11 items-center py-2 underline underline-offset-4" />
      </div>
      {(a.dismissible ?? true) && (
        <button
          onClick={() => onDismiss(a)}
          className="absolute right-0 top-0 flex h-full w-12 items-center justify-center opacity-70 hover:opacity-100"
          aria-label={`Dismiss announcement: ${a.title}`}
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

// ── Inline ──────────────────────────────────────────────────
function Inline({ a, onDismiss }: Props) {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-8 lg:px-10">
      <div
        className={cn(
          'relative flex flex-wrap items-center gap-5 border-l-2 border-[var(--color-accent)] p-5',
          a.background_color ? '' : 'bg-[var(--color-clay-soft)] dark:bg-[var(--color-surface)]'
        )}
        style={customStyle(a)}
      >
        {a.image_url && (
          <span className="relative h-14 w-14 shrink-0 overflow-hidden">
            <Image src={a.image_url} alt="" fill sizes="56px" className="object-contain" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="display text-lg">{a.title}</p>
          {a.body && <p className="mt-1 text-sm text-[var(--color-muted)]">{a.body}</p>}
          <Cta a={a} className="mt-2 text-[var(--color-accent)]" />
        </div>
        {(a.dismissible ?? true) && (
          <button
            onClick={() => onDismiss(a)}
            className="absolute right-3 top-3 p-1 text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
            aria-label={`Dismiss: ${a.title}`}
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Corner card ─────────────────────────────────────────────
function Corner({ a, onDismiss }: Props) {
  const [shown, setShown] = useState((a.delay_seconds ?? 0) === 0)

  useEffect(() => {
    if (shown) return
    const t = setTimeout(() => setShown(true), (a.delay_seconds ?? 0) * 1000)
    return () => clearTimeout(t)
  }, [a.delay_seconds, shown])

  if (!shown) return null

  return (
    <div className="fixed bottom-5 right-5 z-50 w-80 max-w-[calc(100vw-2.5rem)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
      {a.image_url && (
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-[var(--color-linen)]">
          <Image src={a.image_url} alt="" fill sizes="320px" className="object-cover" />
        </div>
      )}
      <div className="relative p-5">
        <p className="display pr-6 text-lg">{a.title}</p>
        {a.body && <p className="mt-1.5 text-sm text-[var(--color-muted)]">{a.body}</p>}
        <Cta a={a} className="mt-3 text-[var(--color-accent)]" />
        {(a.dismissible ?? true) && (
          <button
            onClick={() => onDismiss(a)}
            className="absolute right-3 top-3 p-1 text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
            aria-label={`Dismiss: ${a.title}`}
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Modal ───────────────────────────────────────────────────
function Modal({ a, onDismiss }: Props) {
  const [shown, setShown] = useState((a.delay_seconds ?? 0) === 0)

  useEffect(() => {
    if (shown) return
    const t = setTimeout(() => setShown(true), (a.delay_seconds ?? 0) * 1000)
    return () => clearTimeout(t)
  }, [a.delay_seconds, shown])

  // Escape closes it, and the page behind must not scroll while it is open.
  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss(a)
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [shown, a, onDismiss])

  if (!shown) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-5"
      role="dialog"
      aria-modal="true"
      aria-label={a.title}
      onClick={() => onDismiss(a)}
    >
      <div
        className="relative max-h-[calc(100dvh-2.5rem)] w-full max-w-md overflow-y-auto border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {a.image_url && (
          <div className="relative aspect-[4/3] w-full overflow-hidden bg-[var(--color-linen)]">
            <Image src={a.image_url} alt="" fill sizes="448px" className="object-cover" />
          </div>
        )}
        <div className="p-8 text-center">
          <p className="display text-2xl">{a.title}</p>
          {a.body && (
            <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">{a.body}</p>
          )}
          {a.link_url && (
            <Link
              href={a.link_url}
              onClick={() => onDismiss(a)}
              className="label-caps mt-7 inline-flex h-11 items-center justify-center bg-[var(--color-foreground)] px-7 text-[var(--color-background)] transition-colors hover:bg-[var(--color-clay-deep)]"
            >
              {a.link_label ?? 'Learn more'}
            </Link>
          )}
        </div>
        <button
          onClick={() => onDismiss(a)}
          className="absolute right-3 top-3 bg-[var(--color-surface)]/80 p-1.5 text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          aria-label="Close"
        >
          <X className="h-5 w-5" strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}
