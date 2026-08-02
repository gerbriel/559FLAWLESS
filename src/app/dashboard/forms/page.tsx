import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Check, AlertTriangle, FileWarning, ClipboardList } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { requestNow, formatDateTimeInTimeZone } from '@/lib/time'
import { formApplies, signatureIsCurrent, intakeIsCurrent } from '@/lib/forms'
import { Badge } from '@/components/ui/badge'
import { isFrontDesk, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/** How far ahead to chase. Beyond a fortnight nobody is acting on it yet. */
const HORIZON_DAYS = 14

/**
 * Who still owes paperwork before they arrive.
 *
 * Migration 023 added `appointments.intake_completed_at` and the reminder that
 * goes with it, but nothing ever showed it to staff — so the only way to find
 * out that tomorrow's client had not filled anything in was to open their record
 * and look. This is the list that makes it a five-second check.
 *
 * A form counts as outstanding when it applies to the services booked and the
 * client has either never completed it or their last one has expired. Expiry is
 * the part that is easy to miss: consent is an attestation about a body at a
 * point in time, and a signature from two years ago is not a current one.
 */
export default async function OutstandingFormsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, timezone')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'client') as UserRole
  const timeZone = profile?.timezone ?? 'America/Los_Angeles'
  const now = requestNow()

  // Front desk and above chase paperwork for the whole studio. A provider sees
  // their own diary — which is also all RLS would let them read.
  const wholeStudio = isFrontDesk(role)

  let query = supabase
    .from('appointments')
    .select(
      'id, starts_at, status, client_id, intake_completed_at, guest_first_name, guest_last_name, profiles!appointments_client_id_fkey(first_name, last_name, email, phone), appointment_services(name_snapshot, sort_order, services(id, category_id))'
    )
    .in('status', ['pending', 'confirmed'])
    .gte('starts_at', new Date(now).toISOString())
    .lte('starts_at', new Date(now + HORIZON_DAYS * 86_400_000).toISOString())
    .order('starts_at')
    .limit(300)

  if (!wholeStudio) query = query.eq('provider_id', user.id)

  const [{ data: appointments }, { data: consentForms }, { data: intakeForms }] =
    await Promise.all([
      query,
      supabase
        .from('consent_forms')
        .select('id, title, service_ids, category_ids, revalidate_after_days')
        .eq('is_active', true),
      supabase
        .from('intake_forms')
        .select('id, title, service_ids, category_ids')
        .eq('is_active', true),
    ])

  const clientIds = [
    ...new Set((appointments ?? []).map((a) => a.client_id).filter((id): id is string => !!id)),
  ]

  // One round trip each rather than one per appointment.
  const [{ data: signatures }, { data: submissions }] =
    clientIds.length > 0
      ? await Promise.all([
          supabase
            .from('consent_signatures')
            .select('client_id, consent_form_id, expires_at')
            .in('client_id', clientIds),
          supabase
            .from('intake_submissions')
            .select('client_id, intake_form_id, submitted_at')
            .in('client_id', clientIds)
            .order('submitted_at', { ascending: false }),
        ])
      : [{ data: [] }, { data: [] }]

  // client → the consent versions they hold a live signature for.
  const currentConsent = new Map<string, Set<number>>()
  for (const s of signatures ?? []) {
    if (!signatureIsCurrent(s, now)) continue
    const held = currentConsent.get(s.client_id) ?? new Set<number>()
    held.add(s.consent_form_id)
    currentConsent.set(s.client_id, held)
  }

  // client → most recent submission per intake form (rows arrive newest first).
  const latestIntake = new Map<string, Map<number, { submitted_at: string }>>()
  for (const s of submissions ?? []) {
    const byForm = latestIntake.get(s.client_id) ?? new Map()
    if (!byForm.has(s.intake_form_id)) byForm.set(s.intake_form_id, s)
    latestIntake.set(s.client_id, byForm)
  }

  const rows = (appointments ?? [])
    .map((appt) => {
      const services = (appt.appointment_services ?? [])
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)

      const serviceIds = services
        .map((s) => s.services?.id)
        .filter((id): id is number => typeof id === 'number')
      const categoryIds = services
        .map((s) => s.services?.category_id)
        .filter((id): id is number => typeof id === 'number')

      const held = appt.client_id ? currentConsent.get(appt.client_id) : undefined
      const intakeByForm = appt.client_id ? latestIntake.get(appt.client_id) : undefined

      const missing: string[] = []

      for (const form of intakeForms ?? []) {
        if (!formApplies(form, serviceIds, categoryIds)) continue
        if (!intakeIsCurrent(intakeByForm?.get(form.id), now)) missing.push(form.title)
      }

      for (const form of consentForms ?? []) {
        if (!formApplies(form, serviceIds, categoryIds)) continue
        if (!held?.has(form.id)) missing.push(form.title)
      }

      const client = appt.profiles
      const name = client
        ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim() || 'Client'
        : `${appt.guest_first_name ?? ''} ${appt.guest_last_name ?? ''}`.trim() || 'Guest'

      return {
        id: appt.id,
        startsAt: appt.starts_at,
        name,
        email: client?.email ?? null,
        phone: client?.phone ?? null,
        isGuest: !appt.client_id,
        services: services.map((s) => s.name_snapshot).join(' · '),
        missing,
      }
    })
    .filter((r) => r.missing.length > 0)

  const soon = rows.filter((r) => new Date(r.startsAt).getTime() < now + 2 * 86_400_000)

  return (
    <div>
      {rows.length === 0 ? (
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center">
          <Check
            className="mx-auto h-6 w-6 text-[var(--color-accent)]"
            strokeWidth={1.5}
          />
          <p className="mt-3 text-sm">Everyone booked in the next {HORIZON_DAYS} days is up to date.</p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Nothing to chase.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">
              <strong className="tabular-nums">{rows.length}</strong>{' '}
              {rows.length === 1 ? 'appointment' : 'appointments'} in the next{' '}
              {HORIZON_DAYS} days with paperwork outstanding
            </p>
            {soon.length > 0 && (
              <Badge tone="warning">
                <AlertTriangle className="h-3 w-3" strokeWidth={2} />
                {soon.length} within 48 hours
              </Badge>
            )}
          </div>

          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {rows.map((row) => {
              const urgent = new Date(row.startsAt).getTime() < now + 2 * 86_400_000

              return (
                <li key={row.id} className="flex flex-wrap items-start justify-between gap-4 py-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/dashboard/appointments/${row.id}`}
                        className="text-sm underline-offset-4 hover:underline"
                      >
                        {row.name}
                      </Link>
                      {row.isGuest && <Badge tone="neutral">No account</Badge>}
                      {urgent && <Badge tone="warning">Soon</Badge>}
                    </div>

                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      {formatDateTimeInTimeZone(new Date(row.startsAt), timeZone)}
                      {row.services ? ` · ${row.services}` : ''}
                    </p>

                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {row.missing.map((title) => (
                        <li
                          key={title}
                          className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]"
                        >
                          <FileWarning className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                          {title}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-[var(--color-muted)]">
                    {row.email && (
                      <a href={`mailto:${row.email}`} className="hover:underline">
                        {row.email}
                      </a>
                    )}
                    {row.phone && (
                      <a href={`tel:${row.phone}`} className="hover:underline">
                        {row.phone}
                      </a>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>

          <p className="mt-6 flex items-start gap-2 max-w-prose text-xs text-[var(--color-muted)]">
            <ClipboardList className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span>
              Clients are prompted for these straight after booking and reminded before
              the visit. Anyone without an account fills them in when they arrive —
              there is nowhere to send them a link.
            </span>
          </p>
        </>
      )}
    </div>
  )
}
