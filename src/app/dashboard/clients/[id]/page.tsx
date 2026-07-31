import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AlertTriangle, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
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
  ])

  if (!client) notFound()

  const questions = ((intake?.intake_forms as unknown as { questions: Json } | null)
    ?.questions ?? []) as IntakeQuestion[]
  const answers = (intake?.answers ?? {}) as Record<string, Json>

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
