'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { X, Plus, Lock, Trash2, ArrowUp, ArrowDown, Flag, AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Select } from '@/components/ui/field'
import {
  FORM_APPLIES_TO_NOTHING,
  FORM_TARGETING_HINT,
  formTargetsNothing,
} from '@/lib/forms'
import type { IntakeQuestion } from '@/types/database'

export interface EditableIntakeForm {
  id: number
  slug: string
  version: number
  title: string
  questions: IntakeQuestion[]
  is_active: boolean
  service_ids: number[]
  category_ids: number[]
  /** How many clients have answered this exact version. */
  submission_count: number
}

export interface CategoryOption {
  id: number
  name: string
}

const TYPES: { value: IntakeQuestion['type']; label: string }[] = [
  { value: 'boolean', label: 'Yes / no' },
  { value: 'text', label: 'Free text' },
  { value: 'select', label: 'Pick one' },
  { value: 'multiselect', label: 'Pick any' },
]

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * A stable key for an answer.
 *
 * Answers are stored as `{ [question.id]: value }`, so this id is the only
 * thing tying a stored answer to the question that produced it. It is derived
 * from the label once, at creation, and then never changes — rewording a
 * question must not orphan every answer already given to it.
 */
function questionId(label: string, taken: Set<string>): string {
  const base = slugify(label).slice(0, 40) || 'question'
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/**
 * Write or revise the health questionnaire.
 *
 * Same rule as consent forms, for a different reason: a submission is a bag of
 * answers keyed by question id, so changing the questions of a form that has
 * been answered leaves stored answers with nothing recording what was asked.
 * Editing an answered form therefore publishes a new version — migration 046
 * enforces that at the database, and this form says so before you hit save
 * rather than after.
 */
export function IntakeFormEditor({
  form,
  categories,
}: {
  form?: EditableIntakeForm
  categories: CategoryOption[]
}) {
  const router = useRouter()
  const isNew = !form
  const answered = (form?.submission_count ?? 0) > 0

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState(form?.title ?? '')
  const [active, setActive] = useState(form?.is_active ?? true)
  const [categoryIds, setCategoryIds] = useState<number[]>(form?.category_ids ?? [])
  const [questions, setQuestions] = useState<IntakeQuestion[]>(form?.questions ?? [])

  const questionsChanged =
    !isNew && JSON.stringify(questions) !== JSON.stringify(form.questions)
  const willVersion = answered && questionsChanged

  /**
   * What the targeting would be once this draft saved.
   *
   * `service_ids` is not edited here — a service names itself on the form from
   * the services screen — but it counts, so a form reached only that way is not
   * reported as applying to nothing.
   */
  const allPicked = categories.length > 0 && categories.every((c) => categoryIds.includes(c.id))
  const namedServices = form?.service_ids?.length ?? 0
  const appliesToNothing = formTargetsNothing({
    service_ids: form?.service_ids ?? [],
    category_ids: categoryIds,
  })

  function addQuestion() {
    setQuestions((qs) => [...qs, { id: '', label: '', type: 'boolean' }])
  }

  function patch(index: number, next: Partial<IntakeQuestion>) {
    setQuestions((qs) => qs.map((q, i) => (i === index ? { ...q, ...next } : q)))
  }

  function move(index: number, by: -1 | 1) {
    setQuestions((qs) => {
      const target = index + by
      if (target < 0 || target >= qs.length) return qs
      const next = [...qs]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()

    if (!title.trim()) {
      toast.error('Give the form a title.')
      return
    }
    if (questions.length === 0) {
      toast.error('Add at least one question.')
      return
    }
    if (questions.some((q) => !q.label.trim())) {
      toast.error('Every question needs wording.')
      return
    }
    const needsOptions = questions.filter(
      (q) => (q.type === 'select' || q.type === 'multiselect') && (q.options ?? []).length === 0
    )
    if (needsOptions.length > 0) {
      toast.error(`"${needsOptions[0].label}" needs some choices to pick from.`)
      return
    }

    // Assign ids to new questions only; existing ones keep theirs so answers
    // already given stay attached to the question that produced them.
    const taken = new Set(questions.map((q) => q.id).filter(Boolean))
    const payload: IntakeQuestion[] = questions.map((q) => {
      if (q.id) return { ...q, label: q.label.trim() }
      const id = questionId(q.label, taken)
      taken.add(id)
      return { ...q, id, label: q.label.trim() }
    })

    setBusy(true)
    const supabase = createClient()

    if (willVersion) {
      const { error } = await supabase.rpc('publish_intake_version', {
        p_form_id: form.id,
        p_title: title.trim(),
        p_questions: payload,
        p_category_ids: categoryIds,
      })
      setBusy(false)

      if (error) {
        toast.error(error.message || 'Could not publish that version.')
        return
      }
      toast.success(`Version ${form.version + 1} published.`)
    } else {
      const { error } = isNew
        ? await supabase.from('intake_forms').insert({
            slug: slugify(title) || 'intake',
            version: 1,
            title: title.trim(),
            questions: payload,
            category_ids: categoryIds,
            is_active: active,
          })
        : await supabase
            .from('intake_forms')
            .update({
              title: title.trim(),
              questions: payload,
              category_ids: categoryIds,
              is_active: active,
            })
            .eq('id', form.id)

      setBusy(false)

      if (error) {
        toast.error(error.message || 'Could not save that.')
        return
      }
      toast.success(isNew ? 'Form created.' : 'Saved.')
    }

    setOpen(false)
    router.refresh()
  }

  if (!open) {
    return (
      <Button variant={isNew ? 'primary' : 'subtle'} size="sm" onClick={() => setOpen(true)}>
        {isNew ? (
          <>
            <Plus className="h-4 w-4" strokeWidth={2} />
            New intake form
          </>
        ) : (
          'Edit'
        )}
      </Button>
    )
  }

  return (
    <form
      onSubmit={save}
      className="w-full border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <h3 className="display text-xl">
          {isNew ? 'New intake form' : `Edit ${form.title}`}
        </h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          aria-label="Close"
        >
          <X className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      {willVersion && (
        <p className="mt-4 flex items-start gap-2 border-l-2 border-amber-600 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-transparent dark:text-amber-300">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
          <span>
            {form.submission_count}{' '}
            {form.submission_count === 1 ? 'client has' : 'clients have'} answered
            version {form.version}. Saving publishes <strong>version {form.version + 1}</strong> and
            keeps the old one on record, so their answers stay readable against the
            questions they were actually asked.
          </span>
        </p>
      )}

      <div className="mt-6 space-y-5">
        <Field label="Title">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Health &amp; skin history"
          />
        </Field>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-x-4">
            <p className="label-caps text-[var(--color-muted)]">Ask it for</p>
            {categories.length > 0 && (
              <button
                type="button"
                // Union, not replace: `categories` is the ACTIVE list, and a
                // form may already name one that has since been hidden.
                // Widening the targeting must never narrow it behind the
                // manager's back — a service under a hidden category is still
                // bookable, so dropping the id would silently stop asking for
                // the form there.
                onClick={() =>
                  setCategoryIds((cur) =>
                    allPicked ? [] : [...new Set([...cur, ...categories.map((c) => c.id)])]
                  )
                }
                className="-mr-2 flex min-h-11 items-center px-2 text-xs text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-foreground)] hover:underline"
              >
                {allPicked ? 'Clear all' : 'Every category'}
              </button>
            )}
          </div>

          {categories.length > 0 && (
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {categories.map((c) => (
                <label key={c.id} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={categoryIds.includes(c.id)}
                    onChange={(e) =>
                      setCategoryIds((ids) =>
                        e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id)
                      )
                    }
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  {c.name}
                </label>
              ))}
            </div>
          )}

          <p className="mt-2 text-xs text-[var(--color-muted)]">
            {FORM_TARGETING_HINT}
            {namedServices > 0
              ? ` ${namedServices} ${
                  namedServices === 1 ? 'service names' : 'services name'
                } this form in ${namedServices === 1 ? 'its' : 'their'} own right as well, set under Services.`
              : ''}
          </p>

          {appliesToNothing && (
            <p className="mt-2 flex items-start gap-2 border-l-2 border-amber-600 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-transparent dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              <span>{FORM_APPLIES_TO_NOTHING}</span>
            </p>
          )}
        </div>

        {/* ── Questions ──────────────────────────────── */}
        <div>
          <p className="label-caps mb-3 text-[var(--color-muted)]">Questions</p>

          <ul className="space-y-3">
            {questions.map((q, i) => (
              <li key={i} className="border border-[var(--color-border)] p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <Input
                    value={q.label}
                    onChange={(e) => patch(i, { label: e.target.value })}
                    placeholder="Are you pregnant or nursing?"
                    className="min-w-56 flex-1"
                  />
                  <Select
                    value={q.type}
                    onChange={(e) =>
                      patch(i, {
                        type: e.target.value as IntakeQuestion['type'],
                        // Options and flags only mean something for their own type.
                        options: undefined,
                        flag_when: undefined,
                      })
                    }
                    className="w-36"
                  >
                    {TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label="Move up"
                      className="p-2 text-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:opacity-30"
                    >
                      <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={i === questions.length - 1}
                      aria-label="Move down"
                      className="p-2 text-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:opacity-30"
                    >
                      <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuestions((qs) => qs.filter((_, n) => n !== i))}
                      aria-label="Remove question"
                      className="p-2 text-[var(--color-muted)] hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  </div>
                </div>

                {(q.type === 'select' || q.type === 'multiselect') && (
                  <Input
                    value={(q.options ?? []).join(', ')}
                    onChange={(e) =>
                      patch(i, {
                        options: e.target.value
                          .split(',')
                          .map((o) => o.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="Dry, Oily, Combination, Sensitive"
                    className="mt-3"
                  />
                )}

                {q.type === 'boolean' && (
                  <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={q.flag_when === true}
                      onChange={(e) => patch(i, { flag_when: e.target.checked ? true : undefined })}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <Flag className="h-3.5 w-3.5 text-[var(--color-muted)]" strokeWidth={1.75} />
                    <span className="text-[var(--color-muted)]">
                      Flag the record if they answer yes
                    </span>
                  </label>
                )}

                {q.id && (
                  <p className="mt-2 font-mono text-[10px] text-[var(--color-muted)]">{q.id}</p>
                )}
              </li>
            ))}
          </ul>

          <Button variant="subtle" size="sm" type="button" onClick={addQuestion} className="mt-3">
            <Plus className="h-4 w-4" strokeWidth={2} />
            Add question
          </Button>

          <p className="mt-3 max-w-prose text-xs text-[var(--color-muted)]">
            Flagged answers are surfaced to whoever is treating the client, so put a
            flag on anything that changes what is safe to do — pregnancy, recent
            isotretinoin, a known allergy.
          </p>
        </div>

        {!isNew && (
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
              disabled={willVersion}
            />
            In use
          </label>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : willVersion ? `Publish version ${form.version + 1}` : 'Save'}
        </Button>
        <Button variant="subtle" size="sm" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {form && answered && !willVersion && (
          <Badge tone="neutral">
            <Lock className="h-3 w-3" strokeWidth={2} />
            {form.submission_count} answered
          </Badge>
        )}
      </div>
    </form>
  )
}
