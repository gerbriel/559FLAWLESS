/**
 * Which announcements a given viewer, on a given page, should actually see.
 *
 * Pure functions on purpose. Targeting decides what a real visitor is shown, so
 * it needs to be testable without a browser, a session, or a database — see
 * scripts/announcements.test.ts.
 *
 * Evaluated client-side. The public pages are static/ISR, so the server has no
 * idea who is looking or where they are; it ships every live announcement and
 * the browser filters. That keeps the marketing site cacheable while still
 * allowing "signed-out visitors, on /book only".
 */

import type { Announcement, AnnouncementAudience, UserRole } from '@/types/database'

export type AnnouncementStyle = 'banner' | 'modal' | 'corner' | 'inline'
export type DismissScope = 'session' | 'persist' | 'never'

/** The presentation columns added in 018, which older rows may predate. */
export interface AnnouncementPresentation {
  display_style: AnnouncementStyle
  image_url: string | null
  dismissible: boolean
  dismiss_scope: DismissScope
  delay_seconds: number
}

export type LiveAnnouncement = Announcement & Partial<AnnouncementPresentation>

/** What we know about whoever is looking. */
export interface Viewer {
  /** Null when signed out. */
  userId: string | null
  /** Null when signed out. */
  role: UserRole | null
}

export const ANONYMOUS: Viewer = { userId: null, role: null }

/**
 * Does this page path match one of the target patterns?
 *
 * An empty list means every page. A trailing `/*` matches that prefix and
 * everything under it; `/account/*` covers `/account` itself as well, because
 * "target the account area" plainly includes its front door.
 */
export function matchesPage(targetPages: string[] | null | undefined, pathname: string): boolean {
  if (!targetPages || targetPages.length === 0) return true

  return targetPages.some((raw) => {
    const pattern = raw.trim()
    if (!pattern) return false

    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2) || '/'
      return pathname === prefix || pathname.startsWith(prefix === '/' ? '/' : `${prefix}/`)
    }
    if (pattern === '/*') return true

    // Exact, ignoring a trailing slash so `/book` and `/book/` behave alike.
    const norm = (s: string) => (s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s)
    return norm(pattern) === norm(pathname)
  })
}

/** Does this viewer fall inside the target audience? */
export function matchesAudience(
  audience: AnnouncementAudience | null | undefined,
  viewer: Viewer
): boolean {
  // A row with no targeting set is for everyone.
  if (!audience || typeof audience !== 'object') return true

  switch (audience.type) {
    case 'all':
      return true
    case 'anonymous':
      return viewer.userId === null
    case 'authenticated':
      return viewer.userId !== null
    case 'role':
      return viewer.role !== null && (audience.roles ?? []).includes(viewer.role)
    case 'clients':
      return viewer.userId !== null && (audience.client_ids ?? []).includes(viewer.userId)
    default:
      // Unknown future type: show it rather than silently swallow it, so a
      // mistyped audience is visible to the studio instead of invisible.
      return true
  }
}

/** Is it within its scheduled window? */
export function isLive(a: LiveAnnouncement, now: Date): boolean {
  if (!a.is_active) return false
  if (a.starts_at && new Date(a.starts_at) > now) return false
  if (a.ends_at && new Date(a.ends_at) < now) return false
  return true
}

/**
 * Everything this viewer should see on this page, best first.
 *
 * Sorted by priority (higher wins), then newest. Callers decide how many of
 * each style to actually render — see `pickPerStyle`.
 */
export function selectAnnouncements(
  all: LiveAnnouncement[],
  { pathname, viewer, now = new Date(), dismissed = [] }:
  { pathname: string; viewer: Viewer; now?: Date; dismissed?: number[] }
): LiveAnnouncement[] {
  const skip = new Set(dismissed)

  return all
    .filter((a) => !skip.has(a.id))
    .filter((a) => isLive(a, now))
    .filter((a) => matchesPage(a.target_pages, pathname))
    .filter((a) => matchesAudience(a.target_audience, viewer))
    .sort((x, y) => {
      const p = (y.priority ?? 0) - (x.priority ?? 0)
      if (p !== 0) return p
      return new Date(y.created_at).getTime() - new Date(x.created_at).getTime()
    })
}

/**
 * At most one of each style. Two stacked banners or two modals at once is
 * never what anyone wants; the highest priority in each format wins.
 */
export function pickPerStyle(
  selected: LiveAnnouncement[]
): Partial<Record<AnnouncementStyle, LiveAnnouncement>> {
  const out: Partial<Record<AnnouncementStyle, LiveAnnouncement>> = {}
  for (const a of selected) {
    const style = (a.display_style ?? 'banner') as AnnouncementStyle
    if (!out[style]) out[style] = a
  }
  return out
}

// ── Dismissal ───────────────────────────────────────────────
const KEY = 'fl_dismissed_announcements'

/** Ids this device has dismissed, honouring each row's scope. */
export function readDismissed(): number[] {
  if (typeof window === 'undefined') return []
  const read = (s: Storage) => {
    try {
      const raw = s.getItem(KEY)
      return raw ? (JSON.parse(raw) as number[]) : []
    } catch {
      return []
    }
  }
  return [...read(window.sessionStorage), ...read(window.localStorage)]
}

export function recordDismissal(id: number, scope: DismissScope): void {
  if (typeof window === 'undefined' || scope === 'never') return
  const store = scope === 'persist' ? window.localStorage : window.sessionStorage
  try {
    const raw = store.getItem(KEY)
    const list = raw ? (JSON.parse(raw) as number[]) : []
    if (!list.includes(id)) store.setItem(KEY, JSON.stringify([...list, id]))
  } catch {
    // Storage blocked (private mode, quota). Dismissal just will not persist.
  }
}
