import { redirect } from 'next/navigation'
import { ClipboardList, Lock, Flag } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import {
  IntakeFormEditor,
  type EditableIntakeForm,
} from '@/components/shared/IntakeFormEditor'
import { isManager, type UserRole, type IntakeQuestion } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * The health questionnaire clients fill in before treatment.
 *
 * Superseded versions stay listed for the same reason consent versions do: a
 * submission is answers keyed by question id, and an old answer sheet is only
 * readable next to the questions that produced it.
 */
export default async function IntakeFormsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!isManager((profile?.role ?? 'provider') as UserRole)) redirect('/dashboard')

  const [{ data: forms }, { data: categories }, { data: submissions }] = await Promise.all([
    supabase
      .from('intake_forms')
      .select('id, slug, version, title, questions, is_active, service_ids, category_ids, created_at')
      .order('slug')
      .order('version', { ascending: false }),
    supabase
      .from('service_categories')
      .select('id, name')
      .eq('is_active', true)
      .order('sort_order'),
    supabase.from('intake_submissions').select('intake_form_id').limit(5000),
  ])

  const answeredCount = new Map<number, number>()
  for (const s of submissions ?? []) {
    answeredCount.set(s.intake_form_id, (answeredCount.get(s.intake_form_id) ?? 0) + 1)
  }

  const rows: EditableIntakeForm[] = (forms ?? []).map((f) => ({
    id: f.id,
    slug: f.slug,
    version: f.version,
    title: f.title,
    questions: (f.questions ?? []) as IntakeQuestion[],
    is_active: f.is_active,
    service_ids: f.service_ids ?? [],
    category_ids: f.category_ids ?? [],
    submission_count: answeredCount.get(f.id) ?? 0,
  }))

  const options = (categories ?? []).map((c) => ({ id: c.id, name: c.name }))
  const categoryName = new Map(options.map((c) => [c.id, c.name]))

  const bySlug = new Map<string, EditableIntakeForm[]>()
  for (const r of rows) {
    bySlug.set(r.slug, [...(bySlug.get(r.slug) ?? []), r])
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <p className="max-w-prose text-sm text-[var(--color-muted)]">
          The health and skin history clients complete before their first visit, and
          again once a year. Answers you mark as flags are surfaced to whoever is
          treating them.
        </p>
        <IntakeFormEditor categories={options} />
      </div>

      {bySlug.size === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          No intake forms yet.
        </p>
      ) : (
        <div className="mt-10 space-y-10">
          {[...bySlug.entries()].map(([slug, versions]) => {
            const current = versions.find((v) => v.is_active) ?? versions[0]
            const superseded = versions.filter((v) => v.id !== current.id)
            const flagged = current.questions.filter((q) => q.flag_when !== undefined).length
            const targets = current.category_ids.map((id) => categoryName.get(id)).filter(Boolean)

            return (
              <section
                key={slug}
                className="border border-[var(--color-border)] bg-[var(--color-surface)]"
              >
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] p-6">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <ClipboardList
                        className="h-4 w-4 shrink-0 text-[var(--color-accent)]"
                        strokeWidth={1.5}
                      />
                      <h2 className="display text-xl">{current.title}</h2>
                      <Badge tone="neutral">v{current.version}</Badge>
                      {!current.is_active && <Badge tone="warning">Not in use</Badge>}
                      {current.submission_count > 0 && (
                        <Badge tone="success">
                          <Lock className="h-3 w-3" strokeWidth={2} />
                          {current.submission_count} answered
                        </Badge>
                      )}
                      {flagged > 0 && (
                        <Badge tone="neutral">
                          <Flag className="h-3 w-3" strokeWidth={2} />
                          {flagged} flagged
                        </Badge>
                      )}
                    </div>

                    <p className="mt-2 text-sm text-[var(--color-muted)]">
                      {current.questions.length}{' '}
                      {current.questions.length === 1 ? 'question' : 'questions'} ·{' '}
                      {targets.length > 0 ? `asked for ${targets.join(', ')}` : 'asked of everyone'}
                    </p>

                    <ul className="mt-3 space-y-1">
                      {current.questions.slice(0, 6).map((q) => (
                        <li key={q.id} className="flex items-start gap-2 text-sm">
                          {q.flag_when !== undefined ? (
                            <Flag
                              className="mt-1 h-3 w-3 shrink-0 text-[var(--color-accent)]"
                              strokeWidth={2}
                            />
                          ) : (
                            <span className="mt-2 h-1 w-1 shrink-0 bg-[var(--color-muted)]" />
                          )}
                          <span className="text-[var(--color-muted)]">{q.label}</span>
                        </li>
                      ))}
                      {current.questions.length > 6 && (
                        <li className="text-xs text-[var(--color-muted)]">
                          and {current.questions.length - 6} more
                        </li>
                      )}
                    </ul>
                  </div>

                  <IntakeFormEditor form={current} categories={options} />
                </div>

                {superseded.length > 0 && (
                  <div className="p-6">
                    <p className="label-caps mb-3 text-[var(--color-muted)]">Earlier versions</p>
                    <ul className="space-y-2">
                      {superseded.map((v) => (
                        <li
                          key={v.id}
                          className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--color-muted)]"
                        >
                          <span>
                            v{v.version} — {v.questions.length} questions
                          </span>
                          <span className="text-xs">
                            {v.submission_count > 0
                              ? `${v.submission_count} answer sheet${v.submission_count === 1 ? '' : 's'} still on record`
                              : 'never answered'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
