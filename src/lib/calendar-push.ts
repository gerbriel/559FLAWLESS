import { createAdminClient } from '@/lib/supabase/admin'
import {
  pushEvent,
  deleteEvent,
  fetchBusy,
  calendarSyncConfigured,
} from '@/lib/google-calendar'
import { zonedTimeToUtc } from '@/lib/time'

/**
 * Mirroring the studio's own bookings and time off into Google.
 *
 * Everything here is best-effort and never throws at its caller. A booking that
 * is safely in the database has succeeded; Google being slow or briefly down is
 * not a reason to show a client an error or, worse, to roll back a slot they
 * just took. Failures are logged and the next sync reconciles.
 */

async function connectionFor(providerId: string) {
  if (!calendarSyncConfigured()) return null

  const admin = createAdminClient()
  const { data } = await admin
    .from('calendar_connections')
    .select('calendar_id, push_appointments, revoked_at')
    .eq('provider_id', providerId)
    .maybeSingle()

  if (!data || data.revoked_at || !data.push_appointments) return null
  return { calendarId: data.calendar_id ?? 'primary' }
}

/**
 * Put an appointment in the provider's calendar, or update it if it moved.
 *
 * The client's name goes in the title because the calendar is a working tool
 * for the person doing the treatment. Nothing clinical goes anywhere near it —
 * a Google Calendar entry is not a place for health information, and it syncs
 * to phones, watches and whatever else is signed in.
 */
export async function syncAppointmentToCalendar(appointmentId: string): Promise<void> {
  try {
    const conn = await createAdminClient()
      .from('appointments')
      .select(
        'id, provider_id, starts_at, ends_at, status, google_event_id, guest_first_name, guest_last_name, profiles!appointments_client_id_fkey(first_name, last_name), appointment_services(name_snapshot, sort_order)'
      )
      .eq('id', appointmentId)
      .maybeSingle()

    const appt = conn.data
    if (!appt) return

    const target = await connectionFor(appt.provider_id)
    if (!target) return

    const admin = createAdminClient()

    // A cancelled appointment should leave the calendar, not sit there looking
    // like work.
    if (appt.status === 'cancelled') {
      if (appt.google_event_id) {
        await deleteEvent(appt.provider_id, target.calendarId, appt.google_event_id)
        await admin.from('appointments').update({ google_event_id: null }).eq('id', appt.id)
      }
      return
    }

    const client = appt.profiles as { first_name: string | null; last_name: string | null } | null
    const who =
      (client ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim() : '') ||
      `${appt.guest_first_name ?? ''} ${appt.guest_last_name ?? ''}`.trim() ||
      'Client'

    const services = ((appt.appointment_services ?? []) as {
      name_snapshot: string
      sort_order: number
    }[])
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => s.name_snapshot)
      .join(' + ')

    const { data: provider } = await admin
      .from('profiles')
      .select('timezone')
      .eq('id', appt.provider_id)
      .maybeSingle()

    const eventId = await pushEvent(
      appt.provider_id,
      target.calendarId,
      {
        summary: `${who} — ${services || 'Appointment'}`,
        description: `559 Flawless booking. Open it at /dashboard/appointments/${appt.id}`,
        startsAt: new Date(appt.starts_at),
        endsAt: new Date(appt.ends_at),
        timeZone: provider?.timezone ?? 'America/Los_Angeles',
        reference: `appointment:${appt.id}`,
      },
      appt.google_event_id
    )

    if (eventId && eventId !== appt.google_event_id) {
      await admin.from('appointments').update({ google_event_id: eventId }).eq('id', appt.id)
    }
  } catch (err) {
    console.error('appointment calendar sync failed', appointmentId, err)
  }
}

/**
 * Put a time-off block in the calendar.
 *
 * `availability_blocks` stores wall-clock times in the provider's own zone, so
 * they are converted through zonedTimeToUtc rather than by constructing a Date
 * from the parts — that is the rule for this codebase and it is what makes the
 * DST edges land correctly.
 *
 * A whole-day block (no start or end time) becomes an event covering the
 * working day rather than a true all-day entry, because an all-day Google event
 * pulled back in would block every provider's whole day on the next sync.
 */
export async function syncBlockToCalendar(blockId: number): Promise<void> {
  try {
    const admin = createAdminClient()

    const { data: block } = await admin
      .from('availability_blocks')
      .select('id, provider_id, block_date, start_time, end_time, reason, google_event_id')
      .eq('id', blockId)
      .maybeSingle()

    if (!block) return

    const target = await connectionFor(block.provider_id)
    if (!target) return

    const { data: provider } = await admin
      .from('profiles')
      .select('timezone')
      .eq('id', block.provider_id)
      .maybeSingle()

    const timeZone = provider?.timezone ?? 'America/Los_Angeles'
    const startsAt = zonedTimeToUtc(block.block_date, block.start_time ?? '00:00', timeZone)
    const endsAt = zonedTimeToUtc(
      block.block_date,
      block.end_time ?? '23:59',
      timeZone
    )

    const eventId = await pushEvent(
      block.provider_id,
      target.calendarId,
      {
        summary: block.reason ? `Unavailable — ${block.reason}` : 'Unavailable',
        description: 'Blocked in 559 Flawless. Clients cannot book this time.',
        startsAt,
        endsAt,
        timeZone,
        reference: `block:${block.id}`,
      },
      block.google_event_id
    )

    if (eventId && eventId !== block.google_event_id) {
      await admin
        .from('availability_blocks')
        .update({ google_event_id: eventId })
        .eq('id', block.id)
    }
  } catch (err) {
    console.error('block calendar sync failed', blockId, err)
  }
}

/** Remove a block's event when the block itself is deleted. */
export async function removeBlockFromCalendar(
  providerId: string,
  googleEventId: string | null
): Promise<void> {
  if (!googleEventId) return
  try {
    const target = await connectionFor(providerId)
    if (!target) return
    await deleteEvent(providerId, target.calendarId, googleEventId)
  } catch (err) {
    console.error('block calendar removal failed', googleEventId, err)
  }
}

/**
 * Refresh a provider's cached busy time if it has gone stale, without making
 * anyone wait for it.
 *
 * The scheduled sweep runs daily on Vercel's Hobby plan, which is far too coarse
 * to protect a slot: an appointment added to Google this morning would not block
 * anything until tomorrow. So the availability endpoint nudges a refresh
 * whenever the cache is older than the threshold. The current request answers
 * from slightly stale data — by the time a client has picked a time and pressed
 * book, the next read is fresh.
 *
 * Throttled by `last_synced_at`, so a busy booking page does not hammer Google.
 */
const STALE_AFTER_MS = 10 * 60_000

export async function refreshBusyIfStale(providerId: string): Promise<void> {
  try {
    if (!calendarSyncConfigured()) return

    const admin = createAdminClient()
    const { data: conn } = await admin
      .from('calendar_connections')
      .select('calendar_id, last_synced_at, pull_busy, revoked_at')
      .eq('provider_id', providerId)
      .maybeSingle()

    if (!conn || conn.revoked_at || !conn.pull_busy) return

    const age = conn.last_synced_at ? Date.now() - new Date(conn.last_synced_at).getTime() : Infinity
    if (age < STALE_AFTER_MS) return

    // Claim the refresh before doing the work, so two concurrent requests do
    // not both call Google.
    await admin
      .from('calendar_connections')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('provider_id', providerId)

    const from = new Date(Date.now() - 86_400_000)
    const to = new Date(Date.now() + 90 * 86_400_000)
    const events = await fetchBusy(providerId, conn.calendar_id ?? 'primary', from, to)

    await admin.rpc('replace_calendar_busy', {
      p_provider: providerId,
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_events: events,
    })
  } catch (err) {
    // Never surfaces to a client looking at available times.
    console.error('opportunistic calendar refresh failed', providerId, err)
  }
}
