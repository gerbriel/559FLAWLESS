'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { X, Trash2, Plus, Lock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import {
  formLinkForService,
  formLinkIsInherited,
  removingServiceWouldTargetEveryone,
} from '@/lib/forms'

export interface EditableService {
  id: number
  category_id: number
  name: string
  slug: string
  description: string | null
  details: string | null
  aftercare: string | null
  price_cents: number
  price_is_starting: boolean
  duration_minutes: number
  buffer_minutes: number
  is_active: boolean
  is_featured: boolean
  sort_order: number
  // Gates — admin-only, enforced by a trigger as well as hidden here.
  is_intimate: boolean
  requires_age_verification: boolean
  min_age: number
  requires_consultation: boolean
  patch_test_hours: number
  deposit_cents: number
  cancellation_window_hours: number
}

export interface ServiceCategoryOption {
  id: number
  name: string
}

/**
 * A consent or intake form, as the picker needs it.
 *
 * Which forms a service requires is stored on the FORM — `consent_forms` and
 * `intake_forms` each carry `service_ids` and `category_ids`, and `formApplies`
 * reads them. So this editor writes those same arrays rather than keeping a
 * second list of its own: the Forms screens and this modal are two views of one
 * answer, which is the only way they can't drift apart.
 */
type FormTemplate = {
  kind: 'consent' | 'intake'
  id: number
  title: string
  service_ids: number[]
  category_ids: number[]
}

/** Unique across the two tables, whose ids overlap. */
const templateKey = (t: { kind: string; id: number }) => `${t.kind}:${t.id}`

function saveErrorMessage(error: { code: string; message: string }): string {
  return error.code === '23505'
    ? 'Another service already uses that name. Try a slightly different one.'
    : error.message || 'Could not save that service.'
}

/** "$85.00" → 8500. Returns null if it isn't a number. */
function toCents(dollars: string): number | null {
  const n = Number(dollars.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

const money = (cents: number) => (cents / 100).toFixed(2)

/** A slug the URL can carry: lowercase, hyphens, nothing else. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const BLANK: Omit<EditableService, 'id'> = {
  category_id: 0,
  name: '',
  slug: '',
  description: null,
  details: null,
  aftercare: null,
  price_cents: 0,
  price_is_starting: false,
  duration_minutes: 60,
  buffer_minutes: 10,
  is_active: true,
  is_featured: false,
  sort_order: 0,
  is_intimate: false,
  requires_age_verification: false,
  min_age: 18,
  requires_consultation: false,
  patch_test_hours: 0,
  deposit_cents: 0,
  cancellation_window_hours: 24,
}

/**
 * Create or edit one service.
 *
 * Managers get the menu: name, copy, price, duration, whether it is listed.
 * The booking gates — age verification, patch tests, deposits — are admin-only
 * and simply absent for everyone else. A database trigger enforces the same
 * line, so hiding them here is convenience rather than the actual guard.
 *
 * Which forms the service asks a client for sits between the two, and it is
 * deliberately NOT behind `isAdmin`. The gates are admin-only because migration
 * 022's trigger says so, column by column; form targeting is not one of those
 * columns and lives in another table entirely, where 026 gives the write to
 * `is_manager()`. Inheriting the admin gate by proximity would lock managers out
 * of something the database is happy to let them do. This whole modal is only
 * ever rendered behind `canEdit` — manager and above — so the picker needs no
 * further condition of its own.
 */
export function ServiceEditor({
  service,
  categories,
  isAdmin,
}: {
  service?: EditableService
  categories: ServiceCategoryOption[]
  isAdmin: boolean
}) {
  const router = useRouter()
  const isNew = !service
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [form, setForm] = useState<Omit<EditableService, 'id'>>(
    service ?? { ...BLANK, category_id: categories[0]?.id ?? 0 }
  )
  const [price, setPrice] = useState(money(service?.price_cents ?? 0))
  const [deposit, setDeposit] = useState(money(service?.deposit_cents ?? 0))

  const serviceId = service?.id ?? null

  // The studio's forms, loaded when the modal opens rather than passed down:
  // the services page mounts one of these per row, and eight closed modals
  // should not cost sixteen queries.
  const [templates, setTemplates] = useState<FormTemplate[] | null>(null)
  const [templatesFailed, setTemplatesFailed] = useState(false)
  /** Keys of the forms ticked for this service — only ever the tickable ones. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  /** Titles the last save could not write. Empty is the normal state. */
  const [unwritten, setUnwritten] = useState<string[]>([])
  /**
   * Titles the last save deliberately left alone: unticking them would have
   * emptied both of the form's arrays, which reads as "asked of everyone".
   */
  const [refused, setRefused] = useState<string[]>([])
  /**
   * Set once an insert has succeeded. A retry after a form write failed must
   * update that row, not create the service a second time.
   */
  const [createdId, setCreatedId] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return

    const supabase = createClient()
    let mounted = true

    async function load() {
      // Active only: a superseded version is never asked for, so offering it
      // here would be offering a requirement that can't happen.
      const [consent, intake] = await Promise.all([
        supabase
          .from('consent_forms')
          .select('id, title, service_ids, category_ids')
          .eq('is_active', true)
          .order('title'),
        supabase
          .from('intake_forms')
          .select('id, title, service_ids, category_ids')
          .eq('is_active', true)
          .order('title'),
      ])
      if (!mounted) return

      if (consent.error || intake.error) {
        setTemplatesFailed(true)
        return
      }

      // Intake first: a client fills the health history in before they are
      // asked to consent to anything, and the list reads in that order.
      const rows: FormTemplate[] = [
        ...(intake.data ?? []).map((f) => ({
          kind: 'intake' as const,
          id: f.id,
          title: f.title,
          service_ids: f.service_ids ?? [],
          category_ids: f.category_ids ?? [],
        })),
        ...(consent.data ?? []).map((f) => ({
          kind: 'consent' as const,
          id: f.id,
          title: f.title,
          service_ids: f.service_ids ?? [],
          category_ids: f.category_ids ?? [],
        })),
      ]

      setTemplatesFailed(false)
      setTemplates(rows)
      // Ticks come from the stored arrays every time the modal opens, so a
      // cancelled edit leaves nothing behind — which is what cancelling means.
      setPicked(
        new Set(
          rows
            .filter((t) => serviceId !== null && t.service_ids.includes(serviceId))
            .map(templateKey)
        )
      )
      setUnwritten([])
      setRefused([])
    }

    void load()
    return () => {
      mounted = false
    }
  }, [open, serviceId])

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  /** Back to a blank draft. Only meaningful in create mode. */
  function resetDraft() {
    setForm({ ...BLANK, category_id: categories[0]?.id ?? 0 })
    setCreatedId(null)
    setPicked(new Set())
    setTemplates(null)
  }

  /**
   * Close without saving.
   *
   * If the insert already went through and only the form writes failed,
   * walking away has to abandon that draft as well — otherwise the next
   * "New service" opens holding the service just created and saves over it.
   */
  function close() {
    setOpen(false)
    setUnwritten([])
    setRefused([])
    if (isNew && createdId !== null) resetDraft()
  }

  function toggleForm(key: string, on: boolean) {
    setPicked((cur) => {
      const next = new Set(cur)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  // Judged against the category chosen in the modal right now, not the saved
  // one: changing the category here changes what the service inherits, and the
  // list should say so before the save rather than after it.
  const links = (templates ?? []).map((template) => ({
    template,
    link: formLinkForService(template, serviceId, form.category_id || null),
  }))
  const inherited = links.filter((l) => formLinkIsInherited(l.link))
  const choosable = links.filter((l) => !formLinkIsInherited(l.link))
  const categoryName = categories.find((c) => c.id === form.category_id)?.name ?? 'this category'

  /**
   * This service is the only thing the form names, and it names no category.
   *
   * Judged against what is STORED, not what is ticked: reverting a tick made in
   * this modal writes nothing, so there is nothing to refuse. Only a stored
   * link is at risk, and emptying it asks the form of everyone.
   */
  function isOnlyTarget(template: FormTemplate): boolean {
    return (
      serviceId !== null &&
      template.service_ids.includes(serviceId) &&
      removingServiceWouldTargetEveryone(template, serviceId)
    )
  }

  /**
   * Add or remove this service's id on each form the picker actually controls.
   *
   * Never on an inherited one. A studio-wide form is one with both arrays
   * empty, and switching it off for a single service would mean writing every
   * OTHER service's id into `service_ids` — quietly redefining what all of them
   * require. Same for a category. Those two are shown, not offered.
   *
   * Writing `service_ids` on a form that has been signed or answered is allowed
   * and does not need a new version: 026's guard trigger compares `body`, 046's
   * compares `questions`, and 046 says as much in as many words — "everything
   * else about a live form stays editable — the title, which services it applies
   * to". Routing this through publish_consent_version() would burn a version
   * number on a change that alters not one word anybody agreed to, and orphan
   * the old row's targeting.
   *
   * One untick is refused rather than written: the one that would empty both of
   * the form's arrays. Empty and empty is not "nothing asks for this", it is
   * the studio-wide case — `formApplies` returns true for every appointment —
   * so that write would take a form off one service by putting it in front of
   * every client of every other. `isOnlyTarget` disables the tick before it
   * gets here; this catches the case where the array changed underneath us
   * between the modal opening and the save.
   *
   * Every tick is an UPDATE to a different row in a different table and the
   * browser has no transaction to wrap them in, so this reports per form and
   * the caller says out loud which ones did not land.
   */
  async function applyFormLinks(
    supabase: ReturnType<typeof createClient>,
    savedId: number,
    categoryId: number
  ): Promise<{
    changed: number
    failed: string[]
    refused: { key: string; title: string }[]
    /** Each touched form's `service_ids` as they now stand in the database. */
    stored: Map<string, number[]>
  }> {
    const nothing = {
      changed: 0,
      failed: [] as string[],
      refused: [] as { key: string; title: string }[],
      stored: new Map<string, number[]>(),
    }
    if (!templates) return nothing

    const wanted = templates
      .filter((t) => !formLinkIsInherited(formLinkForService(t, savedId, categoryId)))
      .map((template) => ({ template, on: picked.has(templateKey(template)) }))
      .filter(({ template, on }) => template.service_ids.includes(savedId) !== on)

    if (wanted.length === 0) return nothing

    // Re-read the arrays immediately before rewriting them. The copy loaded
    // when the modal opened may be minutes old, and these arrays are shared —
    // another service's editor, or the form's own page, may have added an id
    // since. If the re-read fails we fall back to the loaded copy rather than
    // abandoning the save.
    // Both arrays, because the refusal below turns on the categories as well.
    const fresh = new Map<string, { service_ids: number[]; category_ids: number[] }>()

    const consentIds = wanted.filter((w) => w.template.kind === 'consent').map((w) => w.template.id)
    if (consentIds.length > 0) {
      const { data } = await supabase
        .from('consent_forms')
        .select('id, service_ids, category_ids')
        .in('id', consentIds)
      for (const row of data ?? []) {
        fresh.set(`consent:${row.id}`, {
          service_ids: row.service_ids ?? [],
          category_ids: row.category_ids ?? [],
        })
      }
    }

    const intakeIds = wanted.filter((w) => w.template.kind === 'intake').map((w) => w.template.id)
    if (intakeIds.length > 0) {
      const { data } = await supabase
        .from('intake_forms')
        .select('id, service_ids, category_ids')
        .in('id', intakeIds)
      for (const row of data ?? []) {
        fresh.set(`intake:${row.id}`, {
          service_ids: row.service_ids ?? [],
          category_ids: row.category_ids ?? [],
        })
      }
    }

    const outcomes = await Promise.all(
      wanted.map(async ({ template, on }) => {
        const key = templateKey(template)
        const stored = fresh.get(key) ?? {
          service_ids: template.service_ids,
          category_ids: template.category_ids,
        }
        const current = stored.service_ids
        const unchanged = { key, title: template.title, ok: true, wrote: false, stored: current }

        if (current.includes(savedId) === on) {
          // Somebody else already made it so. Nothing to write.
          return { ...unchanged, refused: false }
        }

        const next = on
          ? [...current, savedId]
          : current.filter((id) => id !== savedId)

        // The one write that widens a form instead of narrowing it. Refused,
        // and named to the user — a silent no-op here would read as a save.
        if (!on && next.length === 0 && stored.category_ids.length === 0) {
          return { ...unchanged, refused: true }
        }

        // `is_active` and the returned row together turn two silent misfires
        // into reported ones: a form superseded by publish_consent_version()
        // since this modal opened is a different row now, and an UPDATE that
        // RLS refuses matches nothing rather than erroring. Either way no rows
        // come back, and "no rows" is a failure to say out loud — not a save.
        const { data, error } =
          template.kind === 'consent'
            ? await supabase
                .from('consent_forms')
                .update({ service_ids: next })
                .eq('id', template.id)
                .eq('is_active', true)
                .select('id')
            : await supabase
                .from('intake_forms')
                .update({ service_ids: next })
                .eq('id', template.id)
                .eq('is_active', true)
                .select('id')

        const ok = !error && (data?.length ?? 0) > 0
        return {
          key,
          title: template.title,
          ok,
          wrote: true,
          refused: false,
          // A write that did not land leaves the row as the re-read found it.
          stored: ok ? next : current,
        }
      })
    )

    return {
      changed: outcomes.filter((o) => o.ok && o.wrote).length,
      failed: outcomes.filter((o) => !o.ok).map((o) => o.title),
      refused: outcomes.filter((o) => o.refused).map((o) => ({ key: o.key, title: o.title })),
      stored: new Map(outcomes.map((o) => [o.key, o.stored])),
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()

    const priceCents = toCents(price)
    const depositCents = toCents(deposit)
    if (priceCents === null) {
      toast.error('That price is not a number.')
      return
    }
    if (depositCents === null) {
      toast.error('That deposit is not a number.')
      return
    }
    if (depositCents > priceCents) {
      toast.error('The deposit cannot be more than the price.')
      return
    }
    if (form.duration_minutes < 5 || form.duration_minutes > 480) {
      toast.error('Duration must be between 5 and 480 minutes.')
      return
    }
    if (!form.category_id) {
      toast.error('Pick a category.')
      return
    }

    const slug = form.slug.trim() || slugify(form.name)
    const payload = {
      category_id: form.category_id,
      name: form.name.trim(),
      slug,
      description: form.description?.trim() || null,
      details: form.details?.trim() || null,
      aftercare: form.aftercare?.trim() || null,
      price_cents: priceCents,
      price_is_starting: form.price_is_starting,
      duration_minutes: form.duration_minutes,
      buffer_minutes: form.buffer_minutes,
      is_active: form.is_active,
      is_featured: form.is_featured,
      sort_order: form.sort_order,
      // Only sent by an admin. Managers never touch these keys, so an
      // unchanged value can't trip the trigger.
      ...(isAdmin
        ? {
            is_intimate: form.is_intimate,
            requires_age_verification: form.requires_age_verification,
            min_age: form.min_age,
            requires_consultation: form.requires_consultation,
            patch_test_hours: form.patch_test_hours,
            deposit_cents: depositCents,
            cancellation_window_hours: form.cancellation_window_hours,
          }
        : {}),
    }

    setBusy(true)
    const supabase = createClient()

    // A new service has no id, so nothing can list it until the insert returns
    // one — the forms are attached immediately afterwards. `createdId` is that
    // id when an insert in this modal already succeeded and only the form
    // writes failed: the retry updates the row it made, it does not make a
    // second one.
    const existingId = service?.id ?? createdId
    let savedId: number

    if (existingId === null) {
      const { data, error } = await supabase
        .from('services')
        .insert(payload)
        .select('id')
        .single()
      if (error || !data) {
        setBusy(false)
        toast.error(error ? saveErrorMessage(error) : 'Could not save that service.')
        return
      }
      savedId = data.id
      setCreatedId(data.id)
    } else {
      const { error } = await supabase.from('services').update(payload).eq('id', existingId)
      if (error) {
        setBusy(false)
        toast.error(saveErrorMessage(error))
        return
      }
      savedId = existingId
    }

    const forms = await applyFormLinks(supabase, savedId, form.category_id)
    setBusy(false)

    // Bring the loaded copy up to what the database now holds. The modal stays
    // open when something failed, and a second Save has to compare the ticks
    // against reality — against the stale copy, a change made and then undone
    // in one session would be filtered out as "nothing to do" and never written.
    if (forms.stored.size > 0) {
      setTemplates((prev) =>
        prev
          ? prev.map((t) => {
              const stored = forms.stored.get(templateKey(t))
              return stored ? { ...t, service_ids: stored } : t
            })
          : prev
      )
    }

    // A refused untick left the form as it was, so the tick goes back — the
    // checkbox has to show what is stored, not what was asked for.
    if (forms.refused.length > 0) {
      const keys = new Set(forms.refused.map((r) => r.key))
      setPicked((cur) => new Set([...cur, ...keys]))
    }
    setRefused(forms.refused.map((r) => r.title))

    if (forms.failed.length > 0) {
      // The service is saved and some of the forms are not. Name them, keep the
      // ticks as the user set them and leave the modal open, so pressing Save
      // again retries exactly the ones that failed.
      setUnwritten(forms.failed)
      toast.error(
        `${payload.name} was saved, but ${
          forms.failed.length === 1 ? 'one form was' : `${forms.failed.length} forms were`
        } not updated.`
      )
      router.refresh()
      return
    }

    const formNote =
      forms.changed > 0 ? ` ${forms.changed} form${forms.changed === 1 ? '' : 's'} updated.` : ''
    setUnwritten([])

    if (forms.refused.length > 0) {
      // The service saved. Stay open so the reason the tick came back is read
      // rather than flashed past in a toast.
      toast.error(
        `${payload.name} was saved, but ${
          forms.refused.length === 1 ? 'one form was' : `${forms.refused.length} forms were`
        } left as ${forms.refused.length === 1 ? 'it was' : 'they were'}.`
      )
      router.refresh()
      return
    }

    toast.success((isNew ? `${payload.name} added.` : 'Saved.') + formNote)
    setOpen(false)
    if (isNew) resetDraft()
    router.refresh()
  }

  async function remove() {
    if (!service) return
    if (!confirm(`Delete "${service.name}"? If it has ever been booked, switch it off instead.`)) {
      return
    }

    setBusy(true)
    const { error } = await createClient().from('services').delete().eq('id', service.id)
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not delete that service.')
      return
    }
    toast.success(`${service.name} deleted.`)
    setOpen(false)
    router.refresh()
  }

  if (!open) {
    return (
      <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
        {isNew ? (
          <>
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            New service
          </>
        ) : (
          'Edit'
        )}
      </Button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={isNew ? 'Add a service' : `Edit ${service.name}`}
      onClick={() => !busy && close()}
    >
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        className="relative my-8 w-full max-w-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-2xl sm:my-0 sm:p-8"
      >
        <button
          type="button"
          onClick={close}
          disabled={busy}
          className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          aria-label="Close"
        >
          <X className="h-5 w-5" strokeWidth={1.5} />
        </button>

        <h2 className="display pr-10 text-2xl">{isNew ? 'Add a service' : service.name}</h2>

        {unwritten.length > 0 && (
          <div className="mt-4 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm dark:bg-[var(--color-background)]">
            <p className="text-red-700 dark:text-red-400">
              {isNew ? 'The service was created' : 'The service was saved'}, but these forms
              were not changed:
            </p>
            <ul className="mt-1.5 list-disc pl-5 text-[var(--color-muted)]">
              {unwritten.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
            <p className="mt-2 text-[var(--color-muted)]">
              Each form is a separate write, so the others went through. Save again to retry
              these, or set them from the form&rsquo;s own page under Forms.
            </p>
          </div>
        )}

        {refused.length > 0 && (
          <div className="mt-4 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm dark:bg-[var(--color-background)]">
            <p>These forms were left as they were:</p>
            <ul className="mt-1.5 list-disc pl-5 text-[var(--color-muted)]">
              {refused.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
            <p className="mt-2 text-[var(--color-muted)]">
              This service is the only thing each of them names, and they name no category. A
              form that names nothing is asked of every client for every service — so removing
              the last one would widen it, not switch it off. Switch it off, or point it at
              something else, on its own page under Forms.
            </p>
          </div>
        )}

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="sv_name" className="sm:col-span-2">
            <Input
              id="sv_name"
              required
              maxLength={120}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>

          <Field label="Category" htmlFor="sv_cat">
            <Select
              id="sv_cat"
              value={form.category_id}
              onChange={(e) => set('category_id', Number(e.target.value))}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Price" htmlFor="sv_price" hint="In dollars, e.g. 85 or 85.00">
            <Input
              id="sv_price"
              required
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>

          <Field
            label="Duration"
            htmlFor="sv_dur"
            hint="Minutes the client is in the room. 5–480."
          >
            <Input
              id="sv_dur"
              type="number"
              min={5}
              max={480}
              required
              value={form.duration_minutes}
              onChange={(e) => set('duration_minutes', Number(e.target.value))}
            />
          </Field>

          <Field
            label="Turnaround"
            htmlFor="sv_buf"
            hint="Minutes to reset the room afterwards. Blocks the calendar; not charged."
          >
            <Input
              id="sv_buf"
              type="number"
              min={0}
              max={120}
              value={form.buffer_minutes}
              onChange={(e) => set('buffer_minutes', Number(e.target.value))}
            />
          </Field>

          <Field
            label="Short description"
            htmlFor="sv_desc"
            className="sm:col-span-2"
            hint="One or two lines. This is what shows on the menu."
          >
            <Textarea
              id="sv_desc"
              rows={2}
              maxLength={400}
              value={form.description ?? ''}
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>

          <Field
            label="Full details"
            htmlFor="sv_details"
            className="sm:col-span-2"
            hint="What it treats, how it feels, what it is not. Shown on the service's own page."
          >
            <Textarea
              id="sv_details"
              rows={4}
              maxLength={4000}
              value={form.details ?? ''}
              onChange={(e) => set('details', e.target.value)}
            />
          </Field>

          <Field
            label="Aftercare"
            htmlFor="sv_after"
            className="sm:col-span-2"
            hint="Sent to the client after their appointment."
          >
            <Textarea
              id="sv_after"
              rows={3}
              maxLength={4000}
              value={form.aftercare ?? ''}
              onChange={(e) => set('aftercare', e.target.value)}
            />
          </Field>

          <Field label="Order on the menu" htmlFor="sv_sort" hint="Lower shows first.">
            <Input
              id="sv_sort"
              type="number"
              value={form.sort_order}
              onChange={(e) => set('sort_order', Number(e.target.value))}
            />
          </Field>
        </div>

        <div className="mt-5 space-y-3">
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => set('is_active', e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Listed
              <span className="block text-xs text-[var(--color-muted)]">
                Unticking hides it from the menu and from booking. Past appointments keep it.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={form.is_featured}
              onChange={(e) => set('is_featured', e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>Featured on the home page</span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={form.price_is_starting}
              onChange={(e) => set('price_is_starting', e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Price varies
              <span className="block text-xs text-[var(--color-muted)]">
                Shows as &ldquo;from ${price}&rdquo;.
              </span>
            </span>
          </label>
        </div>

        <fieldset className="mt-7 border-t border-[var(--color-border)] pt-6">
          <legend className="label-caps text-[var(--color-muted)]">Forms to fill in first</legend>

          <p className="mt-3 max-w-prose text-xs text-[var(--color-muted)]">
            The same list each form keeps of what it applies to, seen from this service&rsquo;s
            side. Ticking one here is the same switch as ticking this service there.
          </p>

          {templatesFailed ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">
              The forms could not be loaded. Everything else here still saves; nothing about
              which forms this service needs will change.
            </p>
          ) : templates === null ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">Loading forms…</p>
          ) : templates.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">
              No forms are in use yet. They are written under Forms, and can be pointed at this
              service from either side once they exist.
            </p>
          ) : (
            <>
              {choosable.length > 0 && (
                <div className="mt-4 space-y-3">
                  {choosable.map(({ template }) => {
                    const key = templateKey(template)
                    // Ticked-and-locked: the only service it names, no category
                    // behind it. Unticking would empty both arrays, and empty
                    // means everyone.
                    const onlyTarget = isOnlyTarget(template)
                    return (
                      <label
                        key={key}
                        className={`flex items-start gap-3 text-sm ${
                          onlyTarget ? '' : 'cursor-pointer'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={picked.has(key)}
                          disabled={onlyTarget}
                          onChange={(e) => toggleForm(key, e.target.checked)}
                          className="mt-0.5 h-4 w-4 accent-[var(--color-accent)] disabled:opacity-60"
                        />
                        <span>
                          {template.title}
                          <span className="block text-xs text-[var(--color-muted)]">
                            {template.kind === 'consent'
                              ? 'Consent — signed before treatment'
                              : 'Intake — health and skin history'}
                            {onlyTarget
                              ? ' — the only service it asks. A form that names nothing is asked of everyone, so switch it off under Forms rather than here.'
                              : ''}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}

              {inherited.length > 0 && (
                <div className="mt-5 border-l-2 border-[var(--color-border)] pl-4">
                  <p className="label-caps text-[var(--color-muted)]">
                    Already required, from elsewhere
                  </p>
                  <ul className="mt-3 space-y-3">
                    {inherited.map(({ template, link }) => (
                      <li key={templateKey(template)} className="flex items-start gap-3 text-sm">
                        <Lock
                          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)]"
                          strokeWidth={1.5}
                          aria-hidden
                        />
                        <span>
                          {template.title}
                          <span className="block text-xs text-[var(--color-muted)]">
                            {link === 'studio'
                              ? 'Asked of every service.'
                              : `Asked for all ${categoryName}.`}{' '}
                            Not switchable from one service — change it on the form itself,
                            under Forms.
                            {serviceId !== null && template.service_ids.includes(serviceId)
                              ? ' It names this service as well.'
                              : ''}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {isNew && createdId === null && choosable.length > 0 && (
            <p className="mt-4 text-xs text-[var(--color-muted)]">
              Attached the moment the service is created — a form can only name a service that
              has an id.
            </p>
          )}
        </fieldset>

        {isAdmin && (
          <fieldset className="mt-7 border-t border-[var(--color-border)] pt-6">
            <legend className="label-caps text-[var(--color-muted)]">
              Booking rules — admin only
            </legend>

            <div className="mt-4 space-y-3">
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={form.is_intimate}
                  onChange={(e) => set('is_intimate', e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>
                  Intimate service
                  <span className="block text-xs text-[var(--color-muted)]">
                    Described in plain clinical language and handled discreetly.
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={form.requires_age_verification}
                  onChange={(e) => set('requires_age_verification', e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>
                  Age must be confirmed before booking
                  <span className="block text-xs text-[var(--color-muted)]">
                    Required for every intimate service.
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={form.requires_consultation}
                  onChange={(e) => set('requires_consultation', e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>Consultation first — cannot be booked directly online</span>
              </label>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Minimum age" htmlFor="sv_age">
                <Input
                  id="sv_age"
                  type="number"
                  min={0}
                  max={99}
                  value={form.min_age}
                  onChange={(e) => set('min_age', Number(e.target.value))}
                />
              </Field>

              <Field
                label="Patch test"
                htmlFor="sv_patch"
                hint="Hours beforehand. 0 for none."
              >
                <Input
                  id="sv_patch"
                  type="number"
                  min={0}
                  value={form.patch_test_hours}
                  onChange={(e) => set('patch_test_hours', Number(e.target.value))}
                />
              </Field>

              <Field label="Deposit" htmlFor="sv_dep" hint="In dollars. 0 for none.">
                <Input
                  id="sv_dep"
                  inputMode="decimal"
                  value={deposit}
                  onChange={(e) => setDeposit(e.target.value)}
                />
              </Field>

              <Field
                label="Cancellation window"
                htmlFor="sv_cancel"
                hint="Hours before the appointment. Cancelling later forfeits the deposit."
              >
                <Input
                  id="sv_cancel"
                  type="number"
                  min={0}
                  value={form.cancellation_window_hours}
                  onChange={(e) => set('cancellation_window_hours', Number(e.target.value))}
                />
              </Field>
            </div>
          </fieldset>
        )}

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            {/* Once the insert has landed the service exists, so a retry of the
                form writes is a save, not another add. */}
            {busy ? 'Saving…' : isNew && createdId === null ? 'Add service' : 'Save'}
          </Button>
          <Button type="button" variant="subtle" onClick={close} disabled={busy}>
            Cancel
          </Button>
          {!isNew && isAdmin && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="ml-auto flex items-center gap-1.5 text-sm text-red-700 hover:underline dark:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              Delete
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
