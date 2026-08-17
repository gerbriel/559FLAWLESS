'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Lock, Plus, AlertTriangle } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Textarea } from '@/components/ui/field'
import {
  FORM_APPLIES_TO_NOTHING,
  FORM_TARGETING_HINT,
  formTargetsNothing,
} from '@/lib/forms'

export interface EditableConsentForm {
  id: number
  slug: string
  version: number
  title: string
  body: string
  requires_initials: boolean
  revalidate_after_days: number
  is_active: boolean
  service_ids: number[]
  category_ids: number[]
  /** How many clients have signed this exact version. */
  signature_count: number
}

export interface CategoryOption {
  id: number
  name: string
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Write or revise a consent form.
 *
 * The rule that shapes this: once anyone has signed a version, its wording is
 * frozen. Not to protect the archive — every signature already stores a verbatim
 * copy of what was on screen — but so that "version 2" names one specific piece
 * of text. Editing a signed form therefore publishes a new version rather than
 * changing the old one, and the form says so plainly instead of failing at save.
 */
export function ConsentFormEditor({
  form,
  categories,
}: {
  form?: EditableConsentForm
  categories: CategoryOption[]
}) {
  const router = useRouter()
  const isNew = !form
  const signed = (form?.signature_count ?? 0) > 0

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState(form?.title ?? '')
  const [body, setBody] = useState(form?.body ?? '')
  const [initials, setInitials] = useState(form?.requires_initials ?? false)
  const [revalidate, setRevalidate] = useState(String(form?.revalidate_after_days ?? 365))
  const [active, setActive] = useState(form?.is_active ?? true)
  const [categoryIds, setCategoryIds] = useState<number[]>(form?.category_ids ?? [])

  const bodyChanged = !isNew && body !== form.body
  const willVersion = signed && bodyChanged

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

  async function save(e: React.FormEvent) {
    e.preventDefault()

    if (!title.trim()) {
      toast.error('Give the form a title.')
      return
    }
    if (!body.trim()) {
      toast.error('A consent form needs wording.')
      return
    }

    const days = Number(revalidate)
    if (!Number.isFinite(days) || days < 1) {
      toast.error('Re-sign after must be at least one day.')
      return
    }

    setBusy(true)
    const supabase = createClient()

    if (willVersion) {
      // Signed: supersede rather than mutate.
      const { error } = await supabase.rpc('publish_consent_version', {
        p_form_id: form.id,
        p_title: title.trim(),
        p_body: body.trim(),
        p_category_ids: categoryIds,
        p_revalidate_after_days: days,
        p_requires_initials: initials,
      })
      setBusy(false)

      if (error) {
        toast.error(error.message || 'Could not publish that version.')
        return
      }
      toast.success(`Version ${form.version + 1} published.`)
    } else {
      const payload = {
        title: title.trim(),
        body: body.trim(),
        requires_initials: initials,
        revalidate_after_days: days,
        category_ids: categoryIds,
        is_active: active,
      }

      const { error } = isNew
        ? await supabase.from('consent_forms').insert({
            ...payload,
            slug: slugify(title),
            version: 1,
            service_ids: [],
          })
        : await supabase.from('consent_forms').update(payload).eq('id', form.id)

      setBusy(false)

      if (error) {
        toast.error(
          error.code === '23505'
            ? 'A form with that name already exists.'
            : error.message || 'Could not save that form.'
        )
        return
      }
      toast.success(isNew ? 'Form created.' : 'Saved.')
    }

    setOpen(false)
    router.refresh()
  }

  async function remove() {
    if (!form) return
    if (!confirm(`Delete "${form.title}"?`)) return

    setBusy(true)
    const { error } = await createClient().from('consent_forms').delete().eq('id', form.id)
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not delete that form.')
      return
    }
    toast.success('Deleted.')
    setOpen(false)
    router.refresh()
  }

  if (!open) {
    return (
      <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
        {isNew ? (
          <>
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            New form
          </>
        ) : (
          'Edit'
        )}
      </Button>
    )
  }

  return (
    <Modal
      label={isNew ? 'New consent form' : `Edit ${form.title}`}
      title={isNew ? 'New consent form' : form.title}
      onClose={() => setOpen(false)}
      busy={busy}
      onSubmit={save}
      footer={
        <>
          <Button type="submit" disabled={busy}>
            {busy
              ? 'Saving…'
              : willVersion
                ? `Publish version ${form.version + 1}`
                : isNew
                  ? 'Create form'
                  : 'Save'}
          </Button>
          <Button type="button" variant="subtle" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          {!isNew && !signed && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="ml-auto text-sm text-red-700 hover:underline dark:text-red-400"
            >
              Delete
            </button>
          )}
          {!isNew && signed && (
            <span className="ml-auto">
              <Badge tone="neutral">Signed — cannot be deleted</Badge>
            </span>
          )}
        </>
      }
    >
      {form && signed && (
          <div className="flex items-start gap-2.5 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm dark:bg-[var(--color-background)]">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={1.75} />
            <p className="text-[var(--color-muted)]">
              {form.signature_count} {form.signature_count === 1 ? 'client has' : 'clients have'}{' '}
              signed version {form.version}. Changing the wording publishes version{' '}
              {form.version + 1} and retires this one — what they signed stays exactly as it
              was, on their record.
            </p>
          </div>
        )}

        <div className="mt-6 space-y-4">
          <Field label="Title" htmlFor="cf_title">
            <Input
              id="cf_title"
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>

          <Field
            label="Wording"
            htmlFor="cf_body"
            hint="Exactly what the client reads and agrees to. Plain language, one idea per paragraph."
          >
            <Textarea
              id="cf_body"
              required
              rows={14}
              maxLength={20000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="font-mono text-sm"
            />
          </Field>

          <Field
            label="Re-sign after"
            htmlFor="cf_revalidate"
            hint="Days. 365 for an annual health re-attestation; 180 for intimate services."
          >
            <Input
              id="cf_revalidate"
              type="number"
              min={1}
              value={revalidate}
              onChange={(e) => setRevalidate(e.target.value)}
            />
          </Field>

          <fieldset>
            {/* The button lives inside the legend rather than in a wrapper
                beside it: a legend is only the fieldset's caption while it is
                the fieldset's first child, and a div around the two would take
                that away from every screen reader. */}
            <legend className="label-caps mb-3 flex w-full flex-wrap items-center justify-between gap-x-4 text-[var(--color-muted)]">
              <span>Ask for this before</span>
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
                  className="-mr-2 flex min-h-11 items-center px-2 text-xs normal-case tracking-normal text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-foreground)] hover:underline"
                >
                  {allPicked ? 'Clear all' : 'Every category'}
                </button>
              )}
            </legend>
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => {
                const on = categoryIds.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() =>
                      setCategoryIds((cur) =>
                        on ? cur.filter((x) => x !== c.id) : [...cur, c.id]
                      )
                    }
                    aria-pressed={on}
                    className={`min-h-11 border px-3 text-sm transition-colors ${
                      on
                        ? 'border-[var(--color-foreground)] bg-[var(--color-linen)] dark:bg-[var(--color-background)]'
                        : 'border-[var(--color-border)] text-[var(--color-muted)]'
                    }`}
                  >
                    {c.name}
                  </button>
                )
              })}
            </div>
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
          </fieldset>

          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={initials}
              onChange={(e) => setInitials(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Require initials on each section
              <span className="block text-xs text-[var(--color-muted)]">
                For forms where each clause needs separate acknowledgement.
              </span>
            </span>
          </label>

          {!willVersion && (
            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>
                In use
                <span className="block text-xs text-[var(--color-muted)]">
                  Unticking stops it being asked for. Signatures already given are kept.
                </span>
              </span>
            </label>
          )}
        </div>

    </Modal>
  )
}
