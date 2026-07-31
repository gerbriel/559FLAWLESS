import { redirect } from 'next/navigation'
import { Check, AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { requestNow } from '@/lib/time'
import { Badge } from '@/components/ui/badge'
import { IntakeForm } from '@/components/shared/IntakeForm'
import { ConsentSigner } from '@/components/shared/ConsentSigner'
import type { IntakeQuestion } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function FormsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: intakeForm }, { data: lastIntake }, { data: consentForms }, { data: signatures }] =
    await Promise.all([
      supabase
        .from('intake_forms')
        .select('id, title, questions, version')
        .eq('is_active', true)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('intake_submissions')
        .select('id, submitted_at, flags, reviewed_at, answers')
        .eq('client_id', user.id)
        .order('submitted_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('consent_forms')
        .select('id, slug, title, body, version, revalidate_after_days')
        .eq('is_active', true)
        .order('slug'),
      supabase
        .from('consent_signatures')
        .select('consent_form_id, signed_at, expires_at')
        .eq('client_id', user.id),
    ])

  const signedIds = new Set((signatures ?? []).map((s) => s.consent_form_id))

  // A signature past its expiry no longer counts — health attestations have to
  // be re-confirmed, not signed once and forgotten.
  const stale = new Set(
    (signatures ?? [])
      .filter((s) => s.expires_at && new Date(s.expires_at).getTime() < requestNow())
      .map((s) => s.consent_form_id)
  )

  const intakeStale =
    !lastIntake ||
    new Date(lastIntake.submitted_at).getTime() < requestNow() - 365 * 86_400_000

  return (
    <div>
      <h1 className="display text-3xl">Forms & consent</h1>
      <p className="mt-3 max-w-2xl text-[var(--color-muted)]">
        Completing these before you arrive means we spend your appointment on your skin
        rather than on paperwork. Everything here is stored securely and is visible only
        to you and the staff who treat you.
      </p>

      {/* ── Health intake ─────────────────────────────── */}
      <section className="mt-12">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="display text-2xl">Health & skin history</h2>
          {lastIntake && !intakeStale ? (
            <Badge tone="success">
              <Check className="h-3 w-3" strokeWidth={2.5} />
              Complete
            </Badge>
          ) : (
            <Badge tone="warning">Needs completing</Badge>
          )}
          {(lastIntake?.flags.length ?? 0) > 0 && (
            <Badge tone="accent">
              <AlertTriangle className="h-3 w-3" strokeWidth={2} />
              {lastIntake!.flags.length} to review with your provider
            </Badge>
          )}
        </div>

        {lastIntake && !intakeStale ? (
          <p className="mt-4 text-sm text-[var(--color-muted)]">
            Submitted {new Date(lastIntake.submitted_at).toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
            . If anything has changed — new medication, pregnancy, a recent procedure —
            please submit it again below.
          </p>
        ) : (
          <p className="mt-4 text-sm text-[var(--color-muted)]">
            Some conditions and medications make certain treatments unsafe. This takes
            about two minutes.
          </p>
        )}

        {intakeForm && (
          <div className="mt-8">
            <IntakeForm
              formId={intakeForm.id}
              title={intakeForm.title}
              questions={intakeForm.questions as unknown as IntakeQuestion[]}
              previousAnswers={
                (lastIntake?.answers ?? {}) as Record<string, string | boolean | string[]>
              }
              collapsedByDefault={!intakeStale}
            />
          </div>
        )}
      </section>

      {/* ── Consent ───────────────────────────────────── */}
      <section className="mt-16">
        <h2 className="display text-2xl">Consent forms</h2>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          You sign the version shown, and a copy of exactly that text is stored with your
          signature. You can withdraw consent at any time.
        </p>

        <div className="mt-8 space-y-4">
          {(consentForms ?? []).map((form) => {
            const signed = signedIds.has(form.id) && !stale.has(form.id)
            return (
              <ConsentSigner
                key={form.id}
                formId={form.id}
                version={form.version}
                title={form.title}
                body={form.body}
                revalidateAfterDays={form.revalidate_after_days}
                alreadySigned={signed}
              />
            )
          })}
        </div>
      </section>
    </div>
  )
}
