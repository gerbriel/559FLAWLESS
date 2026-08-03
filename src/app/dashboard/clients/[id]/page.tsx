import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AlertTriangle, Check, MessageSquare, Calendar, Activity } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { ClientNoteForm } from '@/components/shared/ClientNoteForm'
import { ClientBanPanel } from '@/components/shared/ClientBanPanel'
import { ClientTagPicker, type ClientTagOption } from '@/components/shared/ClientTagPicker'
import { ClientTimeline } from '@/components/shared/ClientTimeline'
import { ClientMembershipPanel } from '@/components/shared/ClientMembershipPanel'
import { PackageBalanceCard } from '@/components/shared/PackageBalanceCard'
import { PhotoReminderCard } from '@/components/shared/PhotoReminderCard'
import { PhotoReminderPrompt } from '@/components/shared/PhotoReminderPrompt'
import { formatMoney } from '@/lib/utils'
import { requestNow } from '@/lib/time'
import {
  isFrontDesk,
  isManager,
  type IntakeQuestion,
  type Json,
  type UserRole,
} from '@/types/database'
import {
  averageTicketCents,
  noShowRatePct,
  visitCadenceDays,
  type AppointmentPhotoPrompt,
  type ClientBanWithActors,
  type ClientPhotoStatus,
  type ClientTimelineEntry,
  type SignedTreatmentPhoto,
  type TreatmentPhotoRow,
} from '@/types/clientprofile'

export const dynamic = 'force-dynamic'

const FITZPATRICK = ['', 'I', 'II', 'III', 'IV', 'V', 'VI']

/** How long a treatment-photo link is good for. Long enough to look at, short
 *  enough that a copied URL is worthless by the time it is pasted anywhere. */
const SIGNED_URL_TTL_SECONDS = 300

interface Props {
  params: Promise<{ id: string }>
}

export default async function ClientDetailPage({ params }: Props) {
  const { id } = await params
  const supabase = await createClient()
  const now = requestNow()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Two batches, both started before either is awaited — so all sixteen queries
  // are still in flight at once. Split rather than one flat `Promise.all`
  // because postgrest-js resolves each select string at the type level, and
  // sixteen of them in a single destructure is enough to trip TS2589 ("type
  // instantiation is excessively deep") and collapse the whole tuple.
  const corePromise = Promise.all([
    supabase
      .from('profiles')
      .select(
        'id, first_name, last_name, email, phone, pronouns, date_of_birth, created_at, marketing_opt_in',
      )
      .eq('id', id)
      .eq('role', 'client')
      .maybeSingle(),
    supabase.from('client_records').select('*').eq('client_id', id).maybeSingle(),
    supabase
      .from('client_notes')
      .select(
        'id, body, products_used, next_visit_plan, created_at, profiles!client_notes_author_id_fkey(first_name)',
      )
      .eq('client_id', id)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('intake_submissions')
      .select('id, answers, flags, submitted_at, reviewed_at, intake_forms(questions)')
      .eq('client_id', id)
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('consent_signatures')
      .select('id, signed_at, expires_at, consent_forms(title)')
      .eq('client_id', id)
      .order('signed_at', { ascending: false }),
    supabase
      .from('patch_tests')
      .select('id, product, result, performed_at, expires_at, services(name)')
      .eq('client_id', id)
      .order('performed_at', { ascending: false })
      .limit(5),
    supabase
      .from('analytics_events')
      .select('event, path, created_at, meta')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('profiles')
      .select('role')
      .eq('id', user?.id ?? id)
      .maybeSingle(),
  ])

  const extrasPromise = Promise.all([
    // The whole relationship in one pass — visits, purchases, payments, notes,
    // consent, intake, photographs, patch tests, and the ban history. Nine
    // tables' worth of RLS is applied inside the view, so nothing needs
    // re-checking here.
    supabase
      .from('client_timeline')
      .select(
        'client_id, occurred_at, kind, ref, title, detail, amount_cents, status, location_id',
      )
      .eq('client_id', id)
      .order('occurred_at', { ascending: false })
      .limit(200),
    // client_bans has two FKs to profiles, so both embeds name their
    // constraint — `profiles(...)` alone is ambiguous and returns an error.
    supabase
      .from('client_bans')
      .select(
        'id, client_id, location_id, applies_studio_wide, reason, banned_by, banned_at, expires_at, lifted_at, lifted_by, lift_reason, created_at, updated_at, banned_by_profile:profiles!client_bans_banned_by_fkey(first_name, last_name), lifted_by_profile:profiles!client_bans_lifted_by_fkey(first_name, last_name), locations(name)',
      )
      .eq('client_id', id)
      .order('banned_at', { ascending: false }),
    supabase.from('client_photo_status').select('*').eq('client_id', id).maybeSingle(),
    supabase
      .from('treatment_photos')
      .select(
        'id, appointment_id, storage_path, phase, body_area, taken_at, notes, deletion_requested_at',
      )
      .eq('client_id', id)
      .order('taken_at', { ascending: false })
      .limit(12),
    // Only the visits a photograph could still be due on. `photo_due` is null
    // whenever consent does not permit one, so this can never surface a prompt
    // for somebody who has not released.
    supabase
      .from('appointment_photo_prompts')
      .select(
        'appointment_id, client_id, provider_id, location_id, starts_at, status, photo_documented, intimate, documented_services, followup_days, before_count, after_count, progress_count, consent_ok, photo_due',
      )
      .eq('client_id', id)
      .in('status', ['confirmed', 'checked_in', 'completed'])
      .order('starts_at', { ascending: false })
      .limit(5),
    supabase
      .from('client_tag_links')
      .select('tag_id, client_tags(id, name, description, is_alert)')
      .eq('client_id', id),
    supabase.from('client_tags').select('id, name, description, is_alert').order('sort_order'),
    supabase
      .from('locations')
      .select('id, name, timezone, is_active, sort_order')
      .order('sort_order'),
    // Where this account came from, when it came from the studio's own list
    // (051). Null for everybody who signed themselves up, which is most
    // people — it is provenance, not a field.
    supabase
      .from('client_stubs')
      .select('id, note, source, import_batch, claimed_at, created_at')
      .eq('claimed_by', id)
      .maybeSingle(),
  ])

  const [
    { data: client },
    { data: record },
    { data: notes },
    { data: intake },
    { data: signatures },
    { data: patchTests },
    { data: analytics },
    { data: viewer },
  ] = await corePromise

  const [
    { data: timeline },
    { data: bans },
    { data: photoStatus },
    { data: photos },
    { data: prompts },
    { data: tagLinks },
    { data: allTags },
    { data: locations },
    { data: originStub },
  ] = await extrasPromise

  // No row means either the id is wrong or RLS filtered it out — either way
  // there is nothing to show. Without this guard every `client.x` below throws
  // and the page 500s instead of rendering a 404.
  if (!client) notFound()

  const sites = locations ?? []
  // `locations.timezone` is authoritative for a site's wall clock; the primary
  // site is the one the CRM renders in. Nothing here hardcodes Los Angeles.
  const timeZone =
    sites.find((l) => l.is_active)?.timezone ?? sites[0]?.timezone ?? 'America/Los_Angeles'
  const primaryLocationId = sites.find((l) => l.is_active)?.id ?? sites[0]?.id ?? 1
  const siteNames = new Map(sites.map((l) => [l.id, l.name]))

  const role = (viewer?.role ?? 'provider') as UserRole

  // The intake form's question list travels with the submission so a flag id
  // ("accutane") can be rendered as the question the client actually answered.
  const questions = ((intake?.intake_forms as unknown as { questions: Json } | null)
    ?.questions ?? []) as IntakeQuestion[]
  const answers = (intake?.answers ?? {}) as Record<string, Json>

  const tags = (
    (tagLinks ?? [])
      .map((l) => l.client_tags as unknown as ClientTagOption | null)
      .filter(Boolean) as ClientTagOption[]
  ).sort((a, b) => a.name.localeCompare(b.name))

  const banRows = (bans ?? []) as unknown as ClientBanWithActors[]
  const liveBan = banRows.find(
    (b) => !b.lifted_at && (!b.expires_at || new Date(b.expires_at).getTime() > now),
  )

  // Signed, server-side, against a private bucket — never a public URL and
  // never a path handed to the browser to sign for itself.
  const photoRows = (photos ?? []) as TreatmentPhotoRow[]
  let signedPhotos: SignedTreatmentPhoto[] = photoRows.map((p) => ({
    ...p,
    signedUrl: null,
  }))
  if (photoRows.length > 0) {
    const { data: signed } = await supabase.storage.from('treatment').createSignedUrls(
      photoRows.map((p) => p.storage_path),
      SIGNED_URL_TTL_SECONDS,
    )
    const byPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]))
    signedPhotos = photoRows.map((p) => ({
      ...p,
      signedUrl: byPath.get(p.storage_path) ?? null,
    }))
  }

  const promptRows = (prompts ?? []) as AppointmentPhotoPrompt[]
  const duePrompts = promptRows.filter(
    (p) => p.photo_due || (p.photo_documented && !p.consent_ok),
  )

  // Derived from the counters client_record_sync_stats (005) already maintains.
  // Nothing here re-aggregates `appointments` — a second copy of that sum is
  // free to drift from the first.
  const stats = {
    visit_count: record?.visit_count ?? 0,
    no_show_count: record?.no_show_count ?? 0,
    cancel_count: record?.cancel_count ?? 0,
    lifetime_value_cents: record?.lifetime_value_cents ?? 0,
    first_visit_at: record?.first_visit_at ?? null,
    last_visit_at: record?.last_visit_at ?? null,
  }
  const cadence = visitCadenceDays(stats)
  const noShowRate = noShowRatePct(stats)
  const avgTicket = averageTicketCents(stats)

  const productCents = (timeline ?? [])
    .filter((e) => e.kind === 'purchase')
    .reduce((sum, e) => sum + (e.amount_cents ?? 0), 0)

  // Analytics summary
  const pageViews = analytics?.filter((e) => e.event === 'pageview').length ?? 0
  const bookingStarts = analytics?.filter((e) => e.event === 'booking_started').length ?? 0
  const bookingCompletions =
    analytics?.filter((e) => e.event === 'booking_completed').length ?? 0
  const abandonedBookings = bookingStarts - bookingCompletions

  const firstName = client.first_name ?? 'This client'

  const banPanel = (
    <ClientBanPanel
      clientId={client.id}
      clientName={firstName}
      bans={banRows}
      locations={sites.filter((l) => l.is_active).map((l) => ({ id: l.id, name: l.name }))}
      currentLocationId={primaryLocationId}
      timeZone={timeZone}
      canLift={isManager(role)}
      now={now}
    />
  )

  return (
    <div>
      <Link href="/dashboard/clients" className="label-caps text-[var(--color-muted)]">
        ← Clients
      </Link>

      <div className="mt-8 flex flex-wrap items-start justify-between gap-6">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="display text-3xl">
              {client.first_name} {client.last_name}
            </h1>
            {liveBan && <Badge tone="danger">Not taking bookings</Badge>}
          </div>

          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {client.email}
            {client.phone && ` · ${client.phone}`}
            {client.pronouns && ` · ${client.pronouns}`}
          </p>

          <div className="mt-4">
            <ClientTagPicker
              clientId={client.id}
              assigned={tags}
              all={(allTags ?? []) as ClientTagOption[]}
            />
          </div>

          {/* Both doors are front-desk-only, and a provider reaches this page:
              /dashboard/appointments/book-for-client redirects her to
              /dashboard, and `message_threads` is `is_front_desk()` for select
              (006), so Messages would have rendered an empty list. The record
              below is hers to read and write — booking for someone else and
              handling correspondence are not. */}
          {isFrontDesk(role) && (
            <div className="mt-5 flex gap-3">
              <ButtonLink href={`/dashboard/messages?client=${id}`} variant="outline" size="sm">
                <MessageSquare className="h-4 w-4" />
                Message
              </ButtonLink>
              <ButtonLink
                href={`/dashboard/appointments/book-for-client?client=${id}`}
                variant="primary"
                size="sm"
              >
                <Calendar className="h-4 w-4" />
                Book Appointment
              </ButtonLink>
            </div>
          )}
        </div>

        <dl className="grid grid-cols-3 gap-x-8 gap-y-5 text-sm">
          <Stat label="Visits" value={String(stats.visit_count)} />
          <Stat label="Lifetime" value={formatMoney(stats.lifetime_value_cents)} />
          <Stat label="Avg visit" value={avgTicket === null ? '—' : formatMoney(avgTicket)} />
          <Stat label="Products" value={productCents > 0 ? formatMoney(productCents) : '—'} />
          <Stat
            label="Comes every"
            value={
              cadence === null
                ? '—'
                : cadence >= 60
                  ? `${Math.round(cadence / 30)} mo`
                  : `${cadence} d`
            }
          />
          <Stat
            label="No-shows"
            value={
              noShowRate === null
                ? String(stats.no_show_count)
                : `${stats.no_show_count} · ${noShowRate}%`
            }
            tone={noShowRate !== null && noShowRate >= 20 ? 'warning' : undefined}
          />
        </dl>
      </div>

      {/* ── Contraindication flags ────────────────────── */}
      {(intake?.flags.length ?? 0) > 0 && (
        <div className="mt-8 border-l-2 border-amber-600 bg-amber-50 p-5 dark:bg-transparent">
          <p className="label-caps mb-3 flex items-center gap-2 text-amber-800 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
            Review before treating
          </p>
          <ul className="flex flex-wrap gap-2">
            {(intake?.flags ?? []).map((f) => (
              <li key={f}>
                <Badge tone="warning">{questions.find((q) => q.id === f)?.label ?? f}</Badge>
              </li>
            ))}
          </ul>
          {intake?.reviewed_at && (
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              Reviewed{' '}
              {new Date(intake.reviewed_at).toLocaleDateString('en-US', {
                timeZone,
              })}
            </p>
          )}
        </div>
      )}

      {/* A live ban is the first thing you need to know when you open the file;
          with no ban in force the panel is an action and belongs at the bottom. */}
      {liveBan && <div className="mt-10">{banPanel}</div>}

      <div className="mt-12 grid gap-12 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-12">
          {/* ── Photo prompts ─────────────────────────── */}
          {duePrompts.length > 0 && (
            <section className="space-y-4">
              {duePrompts.map((p) => (
                <div key={p.appointment_id}>
                  <p className="label-caps mb-2 text-[var(--color-muted)]">
                    {new Date(p.starts_at).toLocaleDateString('en-US', {
                      timeZone,
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </p>
                  <PhotoReminderPrompt prompt={p} />
                </div>
              ))}
            </section>
          )}

          {/* ── Visit notes ───────────────────────────── */}
          <section>
            <h2 className="display text-2xl">Treatment notes</h2>
            <div className="mt-6">
              <ClientNoteForm clientId={client.id} />
            </div>

            {(notes?.length ?? 0) === 0 ? (
              <p className="mt-6 text-sm text-[var(--color-muted)]">No notes yet.</p>
            ) : (
              <ul className="mt-8 space-y-5">
                {(notes ?? []).map((n) => {
                  const author = n.profiles as {
                    first_name: string | null
                  } | null
                  return (
                    <li
                      key={n.id}
                      className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
                    >
                      <p className="label-caps mb-3 text-[var(--color-muted)]">
                        {new Date(n.created_at).toLocaleDateString('en-US', {
                          timeZone,
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                        {author?.first_name && ` · ${author.first_name}`}
                      </p>
                      <p className="whitespace-pre-line text-sm leading-relaxed">{n.body}</p>
                      {n.products_used && (
                        <p className="mt-3 text-sm text-[var(--color-muted)]">
                          <span className="label-caps mr-2">Products</span>
                          {n.products_used}
                        </p>
                      )}
                      {n.next_visit_plan && (
                        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
                          <span className="label-caps mr-2">Next</span>
                          {n.next_visit_plan}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* ── Everything, in order ──────────────────── */}
          <section>
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <h2 className="display text-2xl">History</h2>
              <span className="text-sm text-[var(--color-muted)]">
                Visits, purchases, payments, forms and photographs
              </span>
            </div>
            <ClientTimeline
              entries={(timeline ?? []) as ClientTimelineEntry[]}
              timeZone={timeZone}
              showLocation={sites.length > 1 ? siteNames : undefined}
            />
          </section>

          {!liveBan && banPanel}
        </div>

        {/* ── Sidebar ─────────────────────────────────── */}
        <aside className="space-y-10">
          {/* Fetches for itself rather than joining the batches above — those
              are already close enough to TS2589 that a seventeenth select
              string in the destructure is what finds it. */}
          <ClientMembershipPanel
            clientId={client.id}
            canManage={isManager(role)}
            timeZone={timeZone}
            now={now}
          />

          {/* Front desk and up only, and that is not a taste decision:
              `client_packages` is `client_id = auth.uid()` or `is_front_desk()`
              (008), so a provider's query comes back empty and the card would
              say "Nothing prepaid" about somebody holding six facials. Silence
              is honest where a zero would be a lie. */}
          {isFrontDesk(role) && (
            <PackageBalanceCard
              clientId={client.id}
              timeZone={timeZone}
              canRedeem
              now={now}
            />
          )}

          {/* Somebody the studio already knew, who accepted an invitation and
              claimed their own record. Worth saying on the file: it explains
              why a brand new account arrived with a phone number nobody here
              typed, and it keeps the old note where a person can find it
              without it being mistaken for clinical history. */}
          {originStub && (
            <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
              <h3 className="label-caps mb-4 text-[var(--color-accent)]">
                From the studio&rsquo;s list
              </h3>
              <p className="text-sm leading-relaxed text-[var(--color-muted)]">
                {originStub.source === 'import'
                  ? 'Imported from the old client list'
                  : 'Added by the studio'}
                {originStub.claimed_at &&
                  `, and claimed on ${new Date(originStub.claimed_at).toLocaleDateString('en-US', {
                    timeZone,
                  })}`}
                .
              </p>
              {originStub.note && (
                <p className="mt-3 whitespace-pre-line text-sm leading-relaxed">
                  {originStub.note}
                </p>
              )}
              <Link
                href={`/dashboard/clients/stubs/${originStub.id}`}
                className="mt-4 inline-flex min-h-11 items-center text-sm text-[var(--color-muted)] underline underline-offset-4 hover:text-[var(--color-foreground)]"
              >
                The record they claimed
              </Link>
            </section>
          )}

          <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h3 className="label-caps mb-5 text-[var(--color-accent)]">Skin profile</h3>
            <dl className="space-y-3 text-sm">
              <Row
                label="Fitzpatrick"
                value={record?.fitzpatrick ? FITZPATRICK[record.fitzpatrick] : '—'}
              />
              <Row label="Skin type" value={record?.skin_type ?? '—'} />
              <Row
                label="Concerns"
                value={record?.concerns?.length ? record.concerns.join(', ') : '—'}
              />
              <Row label="Allergies" value={record?.allergies ?? '—'} />
              <Row label="Medications" value={record?.medications ?? '—'} />
            </dl>
          </section>

          <PhotoReminderCard
            status={(photoStatus ?? null) as ClientPhotoStatus | null}
            photos={signedPhotos}
            timeZone={timeZone}
            now={now}
          />

          {/* Full intake answers */}
          {intake && questions.length > 0 && (
            <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
              <h3 className="label-caps mb-5 text-[var(--color-accent)]">
                Intake ·{' '}
                {new Date(intake.submitted_at).toLocaleDateString('en-US', {
                  timeZone,
                })}
              </h3>
              <dl className="space-y-3 text-sm">
                {questions.map((q) => {
                  const a = answers[q.id]
                  if (a === undefined || a === null || a === '') return null
                  const display = Array.isArray(a)
                    ? a.join(', ')
                    : typeof a === 'boolean'
                      ? a
                        ? 'Yes'
                        : 'No'
                      : String(a)
                  const flagged = q.flag_when !== undefined && a === q.flag_when
                  return (
                    <div key={q.id}>
                      <dt className="text-[var(--color-muted)]">{q.label}</dt>
                      <dd className={flagged ? 'text-amber-700 dark:text-amber-400' : ''}>
                        {display}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            </section>
          )}

          <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h3 className="label-caps mb-5 text-[var(--color-accent)]">Consent on file</h3>
            {(signatures?.length ?? 0) === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">Nothing signed yet.</p>
            ) : (
              <ul className="space-y-2.5 text-sm">
                {(signatures ?? []).map((s) => {
                  const expired = s.expires_at && new Date(s.expires_at).getTime() < now
                  const form = s.consent_forms as { title: string } | null
                  return (
                    <li key={s.id} className="flex items-start gap-2">
                      {expired ? (
                        <AlertTriangle
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600"
                          strokeWidth={2}
                        />
                      ) : (
                        <Check
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600"
                          strokeWidth={2.5}
                        />
                      )}
                      <span>
                        {form?.title}
                        <span className="block text-xs text-[var(--color-muted)]">
                          {expired
                            ? 'Expired — needs re-signing'
                            : new Date(s.signed_at).toLocaleDateString('en-US', { timeZone })}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {(patchTests?.length ?? 0) > 0 && (
            <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
              <h3 className="label-caps mb-5 text-[var(--color-accent)]">Patch tests</h3>
              <ul className="space-y-2.5 text-sm">
                {(patchTests ?? []).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3">
                    <span>
                      {(t.services as { name: string } | null)?.name ?? t.product ?? 'Test'}
                      <span className="block text-xs text-[var(--color-muted)]">
                        {new Date(t.performed_at).toLocaleDateString('en-US', {
                          timeZone,
                        })}
                      </span>
                    </span>
                    <Badge
                      tone={
                        t.result === 'pass'
                          ? 'success'
                          : t.result === 'fail'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {t.result}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Analytics */}
          <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h3 className="label-caps mb-5 text-[var(--color-accent)]">Activity & Analytics</h3>
            <dl className="mb-5 grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-[var(--color-muted)]">Page views</dt>
                <dd className="mt-1 text-lg tabular-nums">{pageViews}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-muted)]">Booking starts</dt>
                <dd className="mt-1 text-lg tabular-nums">{bookingStarts}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-muted)]">Completed</dt>
                <dd className="mt-1 text-lg tabular-nums">{bookingCompletions}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-muted)]">Abandoned</dt>
                <dd className="mt-1 text-lg tabular-nums text-amber-600">
                  {abandonedBookings > 0 ? abandonedBookings : '—'}
                </dd>
              </div>
            </dl>
            {analytics && analytics.length > 0 && (
              <div className="border-t border-[var(--color-border)] pt-4">
                <h4 className="label-caps mb-3 text-xs text-[var(--color-muted)]">
                  Recent Activity
                </h4>
                <ul className="max-h-48 space-y-2 overflow-y-auto text-xs">
                  {analytics.slice(0, 15).map((event, i) => (
                    <li key={i} className="flex items-center gap-2 text-[var(--color-muted)]">
                      <Activity className="h-3 w-3 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {event.event === 'pageview'
                          ? `Viewed ${event.path}`
                          : event.event.replace(/_/g, ' ')}
                      </span>
                      <span className="shrink-0 text-[10px]">
                        {new Date(event.created_at).toLocaleDateString('en-US', {
                          timeZone,
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warning' }) {
  return (
    <div>
      <dt className="label-caps text-[var(--color-muted)]">{label}</dt>
      <dd
        className={`mt-1 text-lg tabular-nums ${
          tone === 'warning' ? 'text-amber-700 dark:text-amber-400' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  )
}
