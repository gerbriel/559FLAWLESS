import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Google Calendar, both directions.
 *
 * Pull: what is already in the provider's own calendar becomes `calendar_busy`,
 * which `src/lib/availability.ts` already consults — so a dentist appointment
 * stops a client booking over it.
 *
 * Push: appointments and time-off blocks become events in that calendar, so the
 * thing she actually looks at during the day is complete.
 *
 * Events we create are tagged with a private extended property. Without that,
 * pulling would read our own pushed appointments back as "external busy" — the
 * studio's own bookings blocking the studio's own slots, and a cancelled
 * appointment leaving a phantom block behind if the delete ever failed.
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

/** Marks an event as ours, so a pull can skip it. */
const SOURCE_TAG = '559flawless'

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events'

// ── Token encryption ────────────────────────────────────────
//
// Refresh tokens are long-lived credentials to someone's personal calendar.
// They are encrypted before they reach the database so that a leaked database
// dump — a backup on a laptop, an over-broad service key — is not also a set of
// working Google credentials.

function encryptionKey(): Buffer | null {
  const raw = process.env.CALENDAR_TOKEN_KEY
  if (!raw) return null
  const key = Buffer.from(raw, 'base64')
  // AES-256 needs exactly 32 bytes; a short key would silently weaken this.
  if (key.length !== 32) {
    throw new Error(
      'CALENDAR_TOKEN_KEY must be 32 bytes, base64-encoded. Generate one with: openssl rand -base64 32'
    )
  }
  return key
}

/** True when the studio has configured everything calendar sync needs. */
export function calendarSyncConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.CALENDAR_TOKEN_KEY
  )
}

export function encryptToken(plain: string): string {
  const key = encryptionKey()
  if (!key) throw new Error('CALENDAR_TOKEN_KEY is not set')

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  // iv.ciphertext.tag — all three are needed to decrypt, none are secret.
  return [iv.toString('base64'), enc.toString('base64'), cipher.getAuthTag().toString('base64')].join(
    '.'
  )
}

export function decryptToken(stored: string): string {
  const key = encryptionKey()
  if (!key) throw new Error('CALENDAR_TOKEN_KEY is not set')

  const [ivB64, dataB64, tagB64] = stored.split('.')
  if (!ivB64 || !dataB64 || !tagB64) throw new Error('Stored token is malformed')

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

// ── OAuth ───────────────────────────────────────────────────

export function connectUrl(origin: string, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID!)
  url.searchParams.set('redirect_uri', `${origin}/api/calendar/callback`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', CALENDAR_SCOPE)
  // Offline access is what yields a refresh token; without it the grant dies in
  // an hour and the calendar quietly stops syncing.
  url.searchParams.set('access_type', 'offline')
  // Google only returns a refresh token on the FIRST consent unless forced.
  // Reconnecting after a revoke would otherwise give us an access token we
  // cannot renew.
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)
  return url.toString()
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  error?: string
  error_description?: string
}

export async function exchangeCode(code: string, origin: string): Promise<TokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${origin}/api/calendar/callback`,
      grant_type: 'authorization_code',
    }),
  })

  const data = (await res.json()) as TokenResponse
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? 'Token exchange failed')
  }
  return data
}

/**
 * A usable access token for this provider, refreshing if the stored one has
 * expired. Returns null when there is no connection, or the grant was revoked —
 * both of which are ordinary states, not errors.
 */
export async function accessTokenFor(providerId: string): Promise<string | null> {
  const admin = createAdminClient()

  const { data: conn } = await admin
    .from('calendar_connections')
    .select('access_token_enc, refresh_token_enc, expires_at, revoked_at')
    .eq('provider_id', providerId)
    .maybeSingle()

  if (!conn || conn.revoked_at) return null

  // A minute of headroom, so a token that expires mid-request does not fail it.
  const stillValid =
    conn.access_token_enc && conn.expires_at && new Date(conn.expires_at).getTime() > Date.now() + 60_000

  if (stillValid) return decryptToken(conn.access_token_enc!)
  if (!conn.refresh_token_enc) return null

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: decryptToken(conn.refresh_token_enc),
      grant_type: 'refresh_token',
    }),
  })

  const data = (await res.json()) as TokenResponse

  if (!res.ok || !data.access_token) {
    // `invalid_grant` means the user revoked access or changed their password.
    // Record it so the dashboard can ask them to reconnect instead of retrying
    // a dead token every five minutes.
    if (data.error === 'invalid_grant') {
      await admin
        .from('calendar_connections')
        .update({ revoked_at: new Date().toISOString(), last_sync_error: 'Access was revoked' })
        .eq('provider_id', providerId)
    }
    return null
  }

  await admin
    .from('calendar_connections')
    .update({
      access_token_enc: encryptToken(data.access_token),
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      revoked_at: null,
    })
    .eq('provider_id', providerId)

  return data.access_token
}

// ── Pull ────────────────────────────────────────────────────

export interface BusyEvent {
  id: string
  starts_at: string
  ends_at: string
  summary: string | null
}

interface GoogleEvent {
  id: string
  status?: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  transparency?: string
  extendedProperties?: { private?: Record<string, string> }
}

/**
 * Everything in the provider's calendar between two instants that should block
 * a booking.
 *
 * Skipped deliberately:
 *  - events we pushed there ourselves, or the studio's own bookings would come
 *    back as external busy time;
 *  - events marked "free" (transparency), because that is exactly what the
 *    person meant when they marked them;
 *  - cancelled events.
 *
 * All-day events are kept, and count as busy for the whole day — an all-day
 * "Vacation" that did not block anything would be a nasty surprise.
 */
export async function fetchBusy(
  providerId: string,
  calendarId: string,
  from: Date,
  to: Date
): Promise<BusyEvent[]> {
  const token = await accessTokenFor(providerId)
  if (!token) return []

  const events: BusyEvent[] = []
  let pageToken: string | undefined

  do {
    const url = new URL(`${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`)
    url.searchParams.set('timeMin', from.toISOString())
    url.searchParams.set('timeMax', to.toISOString())
    // Expand recurring events into their instances — a weekly class blocks a
    // slot every week, not just on the first one.
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('maxResults', '250')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      throw new Error(`Google Calendar returned ${res.status}`)
    }

    const body = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string }

    for (const e of body.items ?? []) {
      if (e.status === 'cancelled') continue
      if (e.transparency === 'transparent') continue
      if (e.extendedProperties?.private?.source === SOURCE_TAG) continue

      const startIso = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null)
      const endIso = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null)
      if (!startIso || !endIso) continue

      events.push({
        id: e.id,
        starts_at: new Date(startIso).toISOString(),
        ends_at: new Date(endIso).toISOString(),
        summary: e.summary ?? null,
      })
    }

    pageToken = body.nextPageToken
  } while (pageToken)

  return events
}

// ── Push ────────────────────────────────────────────────────

export interface PushableEvent {
  summary: string
  description?: string
  startsAt: Date
  endsAt: Date
  timeZone: string
  /** Our own id, so the event can be traced back from the calendar. */
  reference: string
}

/**
 * Create or update an event in the provider's calendar.
 *
 * Returns the Google event id, which the caller stores so the next edit updates
 * rather than duplicating. Returns null when the calendar is not connected —
 * that is not a failure worth blocking a booking over.
 */
export async function pushEvent(
  providerId: string,
  calendarId: string,
  event: PushableEvent,
  existingEventId?: string | null
): Promise<string | null> {
  const token = await accessTokenFor(providerId)
  if (!token) return null

  const payload = {
    summary: event.summary,
    description: event.description,
    start: { dateTime: event.startsAt.toISOString(), timeZone: event.timeZone },
    end: { dateTime: event.endsAt.toISOString(), timeZone: event.timeZone },
    extendedProperties: { private: { source: SOURCE_TAG, reference: event.reference } },
  }

  const base = `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`
  const res = await fetch(existingEventId ? `${base}/${existingEventId}` : base, {
    method: existingEventId ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    // A 404 on update means someone deleted it in Google. Fall back to creating
    // a fresh one rather than losing the appointment from the calendar.
    if (existingEventId && res.status === 404) {
      return pushEvent(providerId, calendarId, event, null)
    }
    console.error('calendar push failed', res.status, await res.text().catch(() => ''))
    return null
  }

  const created = (await res.json()) as { id: string }
  return created.id
}

/** Remove an event. Silent when it is already gone — the goal state is reached. */
export async function deleteEvent(
  providerId: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  const token = await accessTokenFor(providerId)
  if (!token) return

  const res = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  )

  if (!res.ok && res.status !== 404 && res.status !== 410) {
    console.error('calendar delete failed', res.status)
  }
}
