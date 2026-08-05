/**
 * "Pick up where you left off" — the shared logic behind both re-engagement
 * nudges, in one module so the rules cannot drift apart.
 *
 * Two tiers, deliberately different in where the data lives:
 *
 * - **Anonymous**: the booking flow notes the first service someone carried
 *   into "booking started" in localStorage (`fl_considered`), and the home
 *   page offers it back for a fortnight. The server never sees it.
 * - **Signed in**: their own `analytics_events` rows — readable to them under
 *   migration 060's "client reads own events" policy — distilled into the one
 *   service they keep circling, shown on their account page.
 *
 * The intimate-services guardrail is enforced HERE, structurally, on the read
 * side: `consideredSnapshot` refuses to surface a record whose `intimate` flag
 * is set, so the public home page cannot name an intimate service even if a
 * stale or hand-edited record says one. The flag is computed at write time
 * (service OR its category) precisely so the reader never needs the catalogue
 * to make that call. The signed-in tier applies no such filter — the account
 * page is the one place the owner allows it.
 *
 * Consent: writing the localStorage note is collection, so it sits behind the
 * same `fl_analytics_consent` key the trackers honour. The key literal is
 * repeated from ClientAnalytics.tsx because that file is a client module and
 * this one is also imported by Server Components.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'

// ── Anonymous tier: localStorage, no server ────────────────

const CONSIDERED_KEY = 'fl_considered'
const CONSENT_KEY = 'fl_analytics_consent' // mirror of ClientAnalytics.tsx

/** A thought older than this is no longer a thought. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

interface ConsideredRecord {
  slug: string
  name: string
  /** service.is_intimate || category.is_intimate, frozen at write time. */
  intimate: boolean
  /** Date.now() at write time. */
  at: number
  dismissed?: boolean
}

// Same-tab writes do not fire the browser's `storage` event, so the writers
// below notify local subscribers themselves; the `storage` listener covers
// another tab clearing or dismissing the same note.
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function subscribeConsidered(onChange: () => void): () => void {
  listeners.add(onChange)
  window.addEventListener('storage', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onChange)
  }
}

/**
 * Note the service someone was about to book. Called where `booking_started`
 * fires, with the FIRST selected service. A nudge is never worth an error, so
 * every storage failure is swallowed; an opted-out visitor is never recorded.
 */
export function rememberConsidered(service: {
  slug: string
  name: string
  intimate: boolean
}): void {
  if (typeof window === 'undefined') return
  try {
    if (localStorage.getItem(CONSENT_KEY) === 'false') return
    const record: ConsideredRecord = {
      slug: service.slug,
      name: service.name,
      intimate: service.intimate,
      at: Date.now(),
    }
    localStorage.setItem(CONSIDERED_KEY, JSON.stringify(record))
    emit()
  } catch {
    // Storage full or blocked — fine, there is simply no nudge.
  }
}

/** A booked service is not a pending thought. Called on `booking_completed`. */
export function clearConsidered(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(CONSIDERED_KEY)
    emit()
  } catch {
    // Same policy as the writer.
  }
}

/**
 * "Not interested" — keep the record but mark it, so the strip stays gone
 * while a NEW consideration (which overwrites the whole record) still shows.
 */
export function dismissConsidered(): void {
  if (typeof window === 'undefined') return
  try {
    const raw = localStorage.getItem(CONSIDERED_KEY)
    if (!raw) return
    const record = JSON.parse(raw) as ConsideredRecord
    localStorage.setItem(CONSIDERED_KEY, JSON.stringify({ ...record, dismissed: true }))
    emit()
  } catch {
    // A malformed record that cannot be dismissed also cannot render — the
    // snapshot below refuses anything that does not parse.
  }
}

/**
 * The read side, shaped for `useSyncExternalStore`: returns the raw stored
 * string — referentially stable under Object.is — but ONLY when every rule
 * passes, and null otherwise. All refusals live here, in one place:
 * absent, malformed, dismissed, stale, consent since withdrawn, and — the
 * guardrail — intimate. A caller holding a non-null snapshot may parse it
 * with {@link readConsideredDisplay} and trust what comes back.
 */
export function consideredSnapshot(): string | null {
  try {
    if (localStorage.getItem(CONSENT_KEY) === 'false') return null
    const raw = localStorage.getItem(CONSIDERED_KEY)
    if (!raw) return null
    const record = JSON.parse(raw) as Partial<ConsideredRecord>
    if (typeof record.slug !== 'string' || typeof record.name !== 'string') return null
    if (typeof record.at !== 'number') return null
    if (record.dismissed) return null
    // The public reader refuses, whatever the writer did — guardrail 1.
    if (record.intimate) return null
    if (Date.now() - record.at > MAX_AGE_MS) return null
    return raw
  } catch {
    return null
  }
}

/** Server snapshot: the server cannot read localStorage, so there is nothing. */
export function emptyConsideredSnapshot(): string | null {
  return null
}

/** Parse a snapshot {@link consideredSnapshot} has already vetted. */
export function readConsideredDisplay(raw: string): { slug: string; name: string } | null {
  try {
    const record = JSON.parse(raw) as ConsideredRecord
    return { slug: record.slug, name: record.name }
  } catch {
    return null
  }
}

// ── Signed-in tier: their own events, read as them ─────────

/** Only events this recent count as current interest. */
const INTEREST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The one service this client keeps circling, from their OWN
 * `analytics_events` — most frequent over the last 30 days, most recent
 * breaking the tie. Runs on the caller's RLS-scoped client: migration 060's
 * policy is what admits the rows, so before it is applied (or on any error)
 * this returns null and the caller shows nothing. A personalization nudge
 * must never be the reason a page errors (058's rule), so nothing here throws.
 *
 * `nowMs` comes from the caller — a Server Component reads the clock through
 * `requestNow()`, not here.
 */
export async function interestedServiceId(
  supabase: SupabaseClient<Database>,
  userId: string,
  nowMs: number
): Promise<number | null> {
  try {
    const since = new Date(nowMs - INTEREST_WINDOW_MS).toISOString()
    const { data, error } = await supabase
      .from('analytics_events')
      .select('event, meta, created_at')
      .eq('user_id', userId)
      .in('event', ['service_selected', 'booking_started'])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(60)
    if (error || !data || data.length === 0) return null

    // service_selected carries meta.service_id; booking_started carries
    // meta.service_ids. Anything else in meta is ignored, not trusted.
    const count = new Map<number, number>()
    const recency = new Map<number, number>() // index in newest-first order
    data.forEach((row, i) => {
      const meta: Json = row.meta
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return
      const ids: number[] = []
      if (typeof meta.service_id === 'number') ids.push(meta.service_id)
      if (Array.isArray(meta.service_ids)) {
        for (const id of meta.service_ids) if (typeof id === 'number') ids.push(id)
      }
      for (const id of ids) {
        count.set(id, (count.get(id) ?? 0) + 1)
        if (!recency.has(id)) recency.set(id, i)
      }
    })

    let best: number | null = null
    for (const [id, n] of count) {
      if (best === null) {
        best = id
        continue
      }
      const bestCount = count.get(best) ?? 0
      const newer = (recency.get(id) ?? Infinity) < (recency.get(best) ?? Infinity)
      if (n > bestCount || (n === bestCount && newer)) best = id
    }
    return best
  } catch {
    return null
  }
}
