'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ChevronDown } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { cn } from '@/lib/utils'
import { trackFormEvent } from '@/components/shared/ClientAnalytics'
import type { IntakeQuestion } from '@/types/database'

type Answer = string | boolean | string[]

/**
 * Health intake. Contraindication answers are turned into `flags` client-side
 * for the staff queue, but the raw answers are stored too — a provider reviews
 * the answers, not just the flag list.
 */
export function IntakeForm({
  formId,
  title,
  questions,
  previousAnswers,
  collapsedByDefault,
  lastSubmittedAt,
}: {
  formId: number
  title: string
  questions: IntakeQuestion[]
  previousAnswers: Record<string, Answer>
  collapsedByDefault: boolean
  lastSubmittedAt?: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(!collapsedByDefault)
  const [busy, setBusy] = useState(false)
  const [answers, setAnswers] = useState<Record<string, Answer>>(previousAnswers ?? {})
  const [hasTrackedOpen, setHasTrackedOpen] = useState(false)

  useEffect(() => {
    if (open && !hasTrackedOpen) {
      void trackFormEvent('intake', 'started', { form_id: formId })
      setHasTrackedOpen(true)
    }
  }, [open, hasTrackedOpen, formId])

  function set(id: string, value: Answer) {
    setAnswers((a) => ({ ...a, [id]: value }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)

    // A question with `flag_when` raises a flag when the answer matches it.
    const flags = questions
      .filter((q) => q.flag_when !== undefined && answers[q.id] === q.flag_when)
      .map((q) => q.id)

    const supabase = createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      setBusy(false)
      toast.error('Please sign in again.')
      return
    }

    const { error } = await supabase.from('intake_submissions').insert({
      intake_form_id: formId,
      client_id: user.id,
      answers,
      flags,
    })

    if (error) {
      setBusy(false)
      toast.error('Could not save. Please try again.')
      // The raw Postgres message can echo a submitted value, and this table is
      // insert-open to anon. Record that it failed, not what was in it.
      void trackFormEvent('intake', 'abandoned', { form_id: formId, failed: true })
      return
    }

    // Deliberately the COUNT, not the flags. `flags` is health information —
    // accutane, pregnancy, blood thinners — and analytics_events is a table any
    // visitor may insert into, sitting outside the clinical tables and their
    // RLS. How many answers need review is the useful metric; which ones do is
    // clinical data that belongs only in intake_submissions.
    void trackFormEvent('intake', 'completed', { form_id: formId, flag_count: flags.length })

    toast.success(
      flags.length > 0
        ? 'Saved. Your provider will go over a few answers with you.'
        : 'Saved. Thank you.'
    )
    setOpen(false)
    router.refresh()
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4 text-left transition-colors hover:border-[var(--color-accent)]"
      >
        <div>
          <span className="block">{previousAnswers && Object.keys(previousAnswers).length > 0 ? 'Update my health form' : 'Complete health form'}</span>
          {lastSubmittedAt && (
            <span className="mt-1 block text-xs text-[var(--color-muted)]">
              Last completed {new Date(lastSubmittedAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <ChevronDown className="h-4 w-4" strokeWidth={1.5} />
      </button>
    )
  }

  return (
    <form
      onSubmit={submit}
      className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8"
    >
      <h3 className="display text-xl">{title}</h3>

      <div className="mt-8 space-y-7">
        {questions.map((q) => {
          const value = answers[q.id]

          if (q.type === 'boolean') {
            return (
              <fieldset key={q.id}>
                <legend className="mb-3 text-sm">{q.label}</legend>
                <div className="flex gap-3">
                  {[
                    { label: 'No', v: false },
                    { label: 'Yes', v: true },
                  ].map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => set(q.id, opt.v)}
                      className={cn(
                        'label-caps border px-6 py-2.5 transition-colors',
                        value === opt.v
                          ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
                          : 'border-[var(--color-border)] hover:border-[var(--color-accent)]'
                      )}
                      aria-pressed={value === opt.v}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            )
          }

          if (q.type === 'select') {
            return (
              <Field key={q.id} label={q.label} htmlFor={`q_${q.id}`}>
                <Select
                  id={`q_${q.id}`}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(e) => set(q.id, e.target.value)}
                >
                  <option value="">Select…</option>
                  {(q.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          }

          if (q.type === 'multiselect') {
            const selected = Array.isArray(value) ? value : []
            return (
              <fieldset key={q.id}>
                <legend className="mb-3 text-sm">{q.label}</legend>
                <div className="flex flex-wrap gap-2">
                  {(q.options ?? []).map((o) => {
                    const on = selected.includes(o)
                    return (
                      <button
                        key={o}
                        type="button"
                        onClick={() =>
                          set(
                            q.id,
                            on ? selected.filter((s) => s !== o) : [...selected, o]
                          )
                        }
                        className={cn(
                          'border px-3.5 py-2 text-xs transition-colors',
                          on
                            ? 'border-[var(--color-accent)] bg-[var(--color-clay-soft)] text-[var(--color-clay-deep)] dark:bg-transparent dark:text-[var(--color-accent)]'
                            : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]'
                        )}
                        aria-pressed={on}
                      >
                        {o}
                      </button>
                    )
                  })}
                </div>
              </fieldset>
            )
          }

          // text
          const isLong = q.id === 'goals' || q.id === 'current_products'
          return (
            <Field key={q.id} label={q.label} htmlFor={`q_${q.id}`}>
              {isLong ? (
                <Textarea
                  id={`q_${q.id}`}
                  rows={3}
                  maxLength={1000}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(e) => set(q.id, e.target.value)}
                />
              ) : (
                <Input
                  id={`q_${q.id}`}
                  maxLength={500}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(e) => set(q.id, e.target.value)}
                />
              )}
            </Field>
          )
        })}
      </div>

      <p className="mt-8 text-xs leading-relaxed text-[var(--color-muted)]">
        This information is used to keep your treatment safe. It is visible only to you
        and the licensed staff who treat you, and it is never used for marketing.
      </p>

      <div className="mt-6 flex gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Submit'}
        </Button>
        {collapsedByDefault && (
          <Button type="button" variant="subtle" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}
