import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AlertTriangle, Check, MessageSquare, Calendar, Activity } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { ClientNoteForm } from '@/components/shared/ClientNoteForm'
import { formatMoney } from '@/lib/utils'
import { formatDateTimeInTimeZone , requestNow } from '@/lib/time'
import type { IntakeQuestion, Json } from '@/types/database'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'

const FITZPATRICK = ['', 'I', 'II', 'III', 'IV', 'V', 'VI']

interface Props {
  params: Promise<{ id: string }>
}

export default async function ClientDetailPage({ params }: Props) {
  const { id } = await params
  const supabase = await createClient()

  const [
    { data: client },
    { data: record },
    { data: appointments },
    { data: notes },
    { data: intake },
    { data: signatures },
    { data: patchTests },
    { data: analytics },
    { data: purchases },
  ] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, first_name, last_name, email, phone, pronouns, date_of_birth, created_at, marketing_opt_in')
      .eq('id', id)
      .eq('role', 'client')
      .maybeSingle(),
    supabase.from('client_records').select('*').eq('client_id', id).maybeSingle(),
    supabase
      .from('appointments')
      .select('id, starts_at, status, total_cents, appointment_services(name_snapshot, sort_order)')
      .eq('client_id', id)
      .order('starts_at', { ascending: false })
      .limit(20),
    supabase
      .from('client_notes')
      .select('id, body, products_used, next_visit_plan, created_at, profiles!client_notes_author_id_fkey(first_name)')
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
    // What they have bought — in the room and online — so the history is the
    // whole relationship rather than only the treatments.
    supabase
      .from('orders')
      .select(
        'id, order_number, status, channel, payment_method, total_cents, paid_at, created_at, order_items(name_snapshot, qty, unit_price_cents)'
      )
      .eq('client_id', id)
      .in('status', ['paid', 'fulfilling', 'ready_for_pickup', 'shipped', 'completed'])
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  // No row means either the id is wrong or RLS filtered it out — either way
  // there is nothing to show. Without this guard every `client.x` below throws
  // and the page 500s instead of rendering a 404.
  if (!client) notFound()

  // The intake form's question list travels with the submission so a flag id
  // ("accutane") can be rendered as the question the client actually answered.
  const questions = ((intake?.intake_forms as unknown as { questions: Json } | null)
    ?.questions ?? []) as IntakeQuestion[]
  const answers = (intake?.answers ?? {}) as Record<string, Json>

  // Analytics summary
  const pageViews = analytics?.filter(e => e.event === 'pageview').length ?? 0
  const bookingStarts = analytics?.filter(e => e.event === 'booking_started').length ?? 0
  const bookingCompletions = analytics?.filter(e => e.event === 'booking_completed').length ?? 0
  const abandonedBookings = bookingStarts - bookingCompletions

  return (
    <div>
      <Link href="/dashboard/clients" className="label-caps text-[var(--color-muted)]">
        ← Clients
      </Link>

      <div className="mt-8 flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="display text-3xl">
            {client.first_name} {client.last_name}
          </h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {client.email}
            {client.phone && ` · ${client.phone}`}
            {client.pronouns && ` · ${client.pronouns}`}
          </p>
          <div className="mt-4 flex gap-3">
            <ButtonLink 
              href={`/dashboard/messages?client=${id}`}
              variant="outline"
              size="sm"
            >
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

          <h1 className="display text-3xl">
            {client.first_name} {client.last_name}
          </h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {client.email}
            {client.phone && ` · ${client.phone}`}
            {client.pronouns && ` · ${client.pronouns}`}
          </p>
        </div>

        <dl className="flex gap-8 text-sm">
          <div>
            <dt className="label-caps text-[var(--color-muted)]">Visits</dt>
            <dd className="mt-1 text-lg tabular-nums">{record?.visit_count ?? 0}</dd>
          </div>
          <div>
            <dt className="label-caps text-[var(--color-muted)]">Lifetime</dt>
            <dd className="mt-1 text-lg tabular-nums">
              {formatMoney(record?.lifetime_value_cents ?? 0)}
            </dd>
          </div>
          <div>
            <dt className="label-caps text-[var(--color-muted)]">No-shows</dt>
            <dd className="mt-1 text-lg tabular-nums">{record?.no_show_count ?? 0}</dd>
          </div>
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
                <Badge tone="warning">
                  {questions.find((q) => q.id === f)?.label ?? f}
                </Badge>
              </li>
            ))}
          </ul>
          {intake?.reviewed_at && (
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              Reviewed {new Date(intake.reviewed_at).toLocaleDateString()}
            </p>
          )}
        </div>
      )}

      <div className="mt-12 grid gap-12 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-12">
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
                  const author = n.profiles as { first_name: string | null } | null
                  return (
                    <li
                      key={n.id}
                      className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
                    >
                      <p className="label-caps mb-3 text-[var(--color-muted)]">
                        {new Date(n.created_at).toLocaleDateString('en-US', {
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

          {/* ── Visit history ─────────────────────────── */}
          <section>
            <h2 className="display text-2xl">Visit history</h2>
            {(appointments?.length ?? 0) === 0 ? (
              <p className="mt-4 text-sm text-[var(--color-muted)]">No appointments yet.</p>
            ) : (
              <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                {(appointments ?? []).map((a) => (
                  <li key={a.id}>
                    <Link
                      href={`/dashboard/appointments/${a.id}`}
                      className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-4 text-sm transition-colors hover:text-[var(--color-accent)]"
                    >
                      <span>{formatDateTimeInTimeZone(new Date(a.starts_at), STUDIO_TZ)}</span>
                      <span className="text-[var(--color-muted)]">
                        {((a.appointment_services ?? []) as { name_snapshot: string; sort_order: number }[])
                          .sort((x, y) => x.sort_order - y.sort_order)
                          .map((s) => s.name_snapshot)
                          .join(' + ')}
                      </span>
                      <span className="flex items-center gap-3">
                        <Badge tone={a.status === 'completed' ? 'success' : 'neutral'}>
                          {a.status.replace('_', ' ')}
                        </Badge>
                        <span className="tabular-nums">{formatMoney(a.total_cents)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Purchases ─────────────────────────────── */}
          <section>
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <h2 className="display text-2xl">Purchases</h2>
              {(purchases?.length ?? 0) > 0 && (
                <span className="text-sm tabular-nums text-[var(--color-muted)]">
                  {formatMoney(
                    (purchases ?? []).reduce((sum, o) => sum + o.total_cents, 0)
                  )}{' '}
                  in products
                </span>
              )}
            </div>

            {(purchases?.length ?? 0) === 0 ? (
              <p className="mt-4 text-sm text-[var(--color-muted)]">
                Nothing bought yet.
              </p>
            ) : (
              <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                {(purchases ?? []).map((o) => {
                  const items = (o.order_items ?? []) as {
                    name_snapshot: string
                    qty: number
                    unit_price_cents: number
                  }[]

                  return (
                    <li key={o.id} className="py-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm">
                        <span>
                          {new Date(o.paid_at ?? o.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </span>

                        <span className="flex items-center gap-2">
                          <Badge tone={o.channel === 'in_store' ? 'accent' : 'neutral'}>
                            {o.channel === 'in_store' ? 'In studio' : 'Online'}
                          </Badge>
                          {o.payment_method && (
                            <span className="text-xs text-[var(--color-muted)]">
                              {o.payment_method}
                            </span>
                          )}
                          <span className="tabular-nums">{formatMoney(o.total_cents)}</span>
                        </span>
                      </div>

                      <p className="mt-1 text-sm text-[var(--color-muted)]">
                        {items
                          .map((i) => (i.qty > 1 ? `${i.name_snapshot} ×${i.qty}` : i.name_snapshot))
                          .join(', ')}
                      </p>

                      {o.order_number && (
                        <p className="mt-0.5 text-xs tabular-nums text-[var(--color-muted)]">
                          {o.order_number}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>

        {/* ── Sidebar ─────────────────────────────────── */}
        <aside className="space-y-10">
          <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h3 className="label-caps mb-5 text-[var(--color-accent)]">Skin profile</h3>
            <dl className="space-y-3 text-sm">
              <Row label="Fitzpatrick" value={record?.fitzpatrick ? FITZPATRICK[record.fitzpatrick] : '—'} />
              <Row label="Skin type" value={record?.skin_type ?? '—'} />
              <Row
                label="Concerns"
                value={record?.concerns?.length ? record.concerns.join(', ') : '—'}
              />
              <Row label="Allergies" value={record?.allergies ?? '—'} />
              <Row label="Medications" value={record?.medications ?? '—'} />
            </dl>
          </section>

          {/* Full intake answers */}
          {intake && questions.length > 0 && (
            <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
              <h3 className="label-caps mb-5 text-[var(--color-accent)]">
                Intake · {new Date(intake.submitted_at).toLocaleDateString()}
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
                  const expired = s.expires_at && new Date(s.expires_at).getTime() < requestNow()
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
                          {expired ? 'Expired — needs re-signing' : new Date(s.signed_at).toLocaleDateString()}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
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
                <h4 className="label-caps mb-3 text-xs text-[var(--color-muted)]">Recent Activity</h4>
                <ul className="max-h-48 space-y-2 overflow-y-auto text-xs">
                  {analytics.slice(0, 15).map((event, i) => (
                    <li key={i} className="flex items-center gap-2 text-[var(--color-muted)]">
                      <Activity className="h-3 w-3 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {event.event === 'pageview' ? `Viewed ${event.path}` : event.event.replace(/_/g, ' ')}
                      </span>
                      <span className="shrink-0 text-[10px]">
                        {new Date(event.created_at).toLocaleDateString('en-US', {
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
                        {new Date(t.performed_at).toLocaleDateString()}
                      </span>
                    </span>
                    <Badge
                      tone={t.result === 'pass' ? 'success' : t.result === 'fail' ? 'danger' : 'warning'}
                    >
                      {t.result}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}
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
