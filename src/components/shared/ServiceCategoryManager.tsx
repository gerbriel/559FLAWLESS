'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Eye,
  EyeOff,
  FolderTree,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Button, ButtonLink } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/dashboard'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import type { PostgrestError } from '@supabase/supabase-js'

/** A category as this screen edits it. Handed over already in display order. */
export interface ManagedCategory {
  id: number
  name: string
  slug: string
  description: string | null
  image_url: string | null
  is_intimate: boolean
  sort_order: number
  is_active: boolean
}

/**
 * What else in the database points at a category.
 *
 * Counted on the server so the delete can say what it would cost before it is
 * pressed rather than after. `services` is the one that decides whether a
 * delete is possible at all; the other two are rows that would be taken along
 * quietly, which is exactly the sort of thing worth saying out loud.
 */
export interface CategoryUsage {
  category_id: number
  /** Every service filed here, listed or not. */
  services: number
  /** Of those, the ones a client can actually see. */
  listed: number
  /** Reminder/nudge schedules scoped to this category — deleted with it. */
  schedules: number
  /** Per-category commission rates on any plan — deleted with it. */
  commission_rates: number
}

const NO_USAGE: Omit<CategoryUsage, 'category_id'> = {
  services: 0,
  listed: 0,
  schedules: 0,
  commission_rates: 0,
}

type Draft = {
  name: string
  slug: string
  description: string
  image_url: string
  is_intimate: boolean
  is_active: boolean
}

const BLANK: Draft = {
  name: '',
  slug: '',
  description: '',
  image_url: '',
  is_intimate: false,
  is_active: true,
}

/** A slug the URL can carry: lowercase, hyphens, nothing else. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The same thing, but forgiving enough to type into.
 *
 * `slugify` strips a trailing hyphen, which on every keystroke means the hyphen
 * in "skin-lightening" can never be typed — it vanishes the moment it is the
 * last character. So while someone is typing, only the characters a slug cannot
 * contain are replaced; `slugify` still runs on save.
 */
function slugTyping(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * What Postgres said, in a sentence someone can act on.
 *
 * Only the codes this screen can actually provoke are named. Anything else
 * falls through to the database's own message, which is still better than
 * nothing — but a foreign key violation quoting `services_category_id_fkey` at
 * a receptionist is not an error message, it is a shrug.
 */
function explain(error: PostgrestError | null, fallback: string): string {
  switch (error?.code) {
    case '23505':
      return 'Another category already uses that web address. Try a different one.'
    case '23503':
      return 'Something is still filed under this category, so the database refused to delete it. Reload the page — a service was probably moved into it while this was open.'
    case '42501':
      return 'Your account is not allowed to change categories. Only a manager or an admin can.'
    default:
      return error?.message || fallback
  }
}

/**
 * Create, rename, reorder, hide and delete the groupings the menu is built
 * from.
 *
 * Two things about this screen are deliberate.
 *
 * **The slug does not follow the name.** `/services/<slug>` is a real public
 * page, printed on cards and pasted into text messages, and nothing in this app
 * redirects an old address to a new one. So renaming "Waxing" to "Waxing &
 * Sugaring" changes the heading and leaves the address alone; changing the
 * address is a separate, deliberate action with the consequence written next to
 * it.
 *
 * **A delete never takes the menu with it.** `services.category_id` is
 * `on delete restrict`, so Postgres refuses outright while anything is filed
 * here — it does not cascade and it never will silently. Rather than offering a
 * button that fails, the count is shown, the services can be moved somewhere
 * else in one go, and only an empty category offers a delete at all. The 23503
 * catch above is for the race where someone files a service here while this
 * page is open.
 *
 * Writes are `manager` and above (migration 022 replaced 002's admin-only
 * policy). A provider or a receptionist sees the same list and no controls,
 * because a button whose only outcome is a refusal is worse than no button.
 */
export function ServiceCategoryManager({
  categories,
  usage,
  canManage,
}: {
  categories: ManagedCategory[]
  usage: CategoryUsage[]
  canManage: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK)
  /** Once the address has been typed by hand, stop deriving it from the name. */
  const [slugTouched, setSlugTouched] = useState(false)
  /** The address is only editable on an existing category by asking for it. */
  const [addressOpen, setAddressOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [moveTarget, setMoveTarget] = useState('')

  const usageFor = useMemo(
    () => new Map(usage.map((u) => [u.category_id, u])),
    [usage]
  )
  const usageOf = (id: number) => usageFor.get(id) ?? NO_USAGE

  const editingCategory =
    typeof editing === 'number' ? categories.find((c) => c.id === editing) ?? null : null

  function startNew() {
    setDraft(BLANK)
    setSlugTouched(false)
    setAddressOpen(true)
    setConfirmDelete(false)
    setMoveTarget('')
    setEditing('new')
  }

  function startEdit(category: ManagedCategory) {
    setDraft({
      name: category.name,
      slug: category.slug,
      description: category.description ?? '',
      image_url: category.image_url ?? '',
      is_intimate: category.is_intimate,
      is_active: category.is_active,
    })
    setSlugTouched(true)
    setAddressOpen(false)
    setConfirmDelete(false)
    setMoveTarget('')
    setEditing(category.id)
  }

  /** Typing a name fills the address in until someone types one themselves. */
  function setName(name: string) {
    setDraft((d) => ({ ...d, name, slug: slugTouched ? d.slug : slugify(name) }))
  }

  async function save() {
    const target = editing
    if (target === null) return

    const name = draft.name.trim()
    if (!name) {
      toast.error('Give the category a name — it is the heading clients read.')
      return
    }

    // Tidied here rather than while it was being typed: a trailing hyphen is
    // half a word, not a decision.
    const slug = slugify(draft.slug) || slugify(name)
    if (!slug) {
      toast.error('That name has no letters or numbers in it, so there is no web address to make from it.')
      return
    }

    // The one change on this screen that breaks something outside it.
    if (
      editingCategory &&
      slug !== editingCategory.slug &&
      !confirm(
        `Move ${editingCategory.name} from /services/${editingCategory.slug} to /services/${slug}?\n\n` +
          'Every link to the old address stops working — a card, a text message, a post. Nothing redirects it.'
      )
    ) {
      return
    }

    const row = {
      name,
      slug,
      description: draft.description.trim() || null,
      image_url: draft.image_url.trim() || null,
      is_intimate: draft.is_intimate,
      is_active: draft.is_active,
      // A new category joins the end of the menu rather than tying with
      // whatever is already at the front.
      ...(target === 'new'
        ? { sort_order: categories.reduce((n, c) => Math.max(n, c.sort_order), 0) + 1 }
        : {}),
    }

    setBusy(true)
    const supabase = createClient()
    const { error } =
      target === 'new'
        ? await supabase.from('service_categories').insert(row)
        : await supabase.from('service_categories').update(row).eq('id', target)
    setBusy(false)

    if (error) {
      toast.error(explain(error, 'Could not save that category.'))
      return
    }

    toast.success(target === 'new' ? `${name} added.` : 'Saved.')
    setEditing(null)
    router.refresh()
  }

  /**
   * Move one place up or down the menu.
   *
   * Every row is renumbered from 1 rather than swapping two values, because
   * `sort_order` defaults to 0 and a menu where everything ties has no order to
   * swap. Only the rows whose number actually changed are written.
   */
  async function move(index: number, by: -1 | 1) {
    const to = index + by
    if (to < 0 || to >= categories.length) return

    const next = [...categories]
    ;[next[index], next[to]] = [next[to], next[index]]

    const changed = next
      .map((c, i) => ({ id: c.id, sort_order: i + 1, before: c.sort_order }))
      .filter((r) => r.sort_order !== r.before)
    if (changed.length === 0) return

    setBusy(true)
    const supabase = createClient()
    const results = await Promise.all(
      changed.map((r) =>
        supabase.from('service_categories').update({ sort_order: r.sort_order }).eq('id', r.id)
      )
    )
    setBusy(false)

    const failed = results.find((r) => r.error)
    if (failed) {
      toast.error(explain(failed.error, 'Could not reorder the menu.'))
      return
    }
    router.refresh()
  }

  /** The one-click version of the Listed tick in the editor. */
  async function toggleActive(category: ManagedCategory) {
    setBusy(true)
    const { error } = await createClient()
      .from('service_categories')
      .update({ is_active: !category.is_active })
      .eq('id', category.id)
    setBusy(false)

    if (error) {
      toast.error(explain(error, 'Could not change that.'))
      return
    }
    toast.success(
      category.is_active
        ? `${category.name} is off the site. Its services keep their prices and their history.`
        : `${category.name} is back on the site.`
    )
    router.refresh()
  }

  /** Refile every service under another category — the way out of a restrict. */
  async function moveServices(category: ManagedCategory) {
    const to = Number(moveTarget)
    if (!to) {
      toast.error('Pick the category they should move to.')
      return
    }

    const n = usageOf(category.id).services
    setBusy(true)
    const { error } = await createClient()
      .from('services')
      .update({ category_id: to })
      .eq('category_id', category.id)
    setBusy(false)

    if (error) {
      toast.error(explain(error, 'Could not move those services.'))
      return
    }

    const name = categories.find((c) => c.id === to)?.name ?? 'the other category'
    toast.success(`${plural(n, 'service', 'services')} moved to ${name}.`)
    setMoveTarget('')
    router.refresh()
  }

  async function remove(category: ManagedCategory) {
    setBusy(true)
    const { error } = await createClient()
      .from('service_categories')
      .delete()
      .eq('id', category.id)
    setBusy(false)

    if (error) {
      toast.error(explain(error, 'Could not delete that category.'))
      return
    }
    toast.success(`${category.name} deleted.`)
    setEditing(null)
    router.refresh()
  }

  /* ── The panel that does the editing ───────────────────────── */

  const stats = editingCategory ? usageOf(editingCategory.id) : NO_USAGE
  const elsewhere = editingCategory
    ? categories.filter((c) => c.id !== editingCategory.id)
    : []

  const editor = (
    <div className="space-y-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" htmlFor="cat_name" className="sm:col-span-2">
          <Input
            id="cat_name"
            maxLength={80}
            value={draft.name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Facials"
          />
        </Field>

        {addressOpen ? (
          <Field
            label="Web address"
            htmlFor="cat_slug"
            className="sm:col-span-2"
            hint={
              editingCategory
                ? 'Anything already shared that points at the old address will stop working — nothing here redirects it.'
                : 'Lowercase letters, numbers and hyphens. Chosen once; renaming the category later leaves it alone.'
            }
          >
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-sm text-[var(--color-muted)]">/services/</span>
              <Input
                id="cat_slug"
                maxLength={80}
                value={draft.slug}
                onChange={(e) => {
                  setSlugTouched(true)
                  setDraft((d) => ({ ...d, slug: slugTyping(e.target.value) }))
                }}
                placeholder="facials"
              />
            </div>
          </Field>
        ) : (
          <div className="sm:col-span-2">
            <p className="label-caps mb-2 text-[var(--color-muted)]">Web address</p>
            <p className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-[var(--color-muted)]">/services/{draft.slug}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="px-0"
                onClick={() => setAddressOpen(true)}
              >
                Change it
              </Button>
            </p>
            <p className="mt-1.5 text-xs text-[var(--color-muted)]">
              Renaming the category does not move the page. That is on purpose: this
              address is what clients have been sent.
            </p>
          </div>
        )}

        <Field
          label="Description"
          htmlFor="cat_desc"
          className="sm:col-span-2"
          hint="A line or two under the heading on the public menu."
        >
          <Textarea
            id="cat_desc"
            rows={2}
            maxLength={400}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </Field>

        <Field
          label="Picture"
          htmlFor="cat_img"
          className="sm:col-span-2"
          hint="A link to the photograph for this category. Services with no photograph of their own borrow it."
        >
          <Input
            id="cat_img"
            value={draft.image_url}
            onChange={(e) => setDraft((d) => ({ ...d, image_url: e.target.value }))}
            placeholder="https://…"
          />
        </Field>
      </div>

      <div className="space-y-3">
        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={draft.is_active}
            onChange={(e) => setDraft((d) => ({ ...d, is_active: e.target.checked }))}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Listed
            <span className="block text-xs text-[var(--color-muted)]">
              Unticking takes the category and its page off the site. The services
              underneath keep their prices, their bookings and their history — this is
              the safe alternative to deleting.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={draft.is_intimate}
            onChange={(e) => setDraft((d) => ({ ...d, is_intimate: e.target.checked }))}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Intimate services
            <span className="block text-xs text-[var(--color-muted)]">
              Marks the category 18+ on the public menu and keeps its language plain and
              clinical. It is a label, not the gate: what a client must confirm before
              booking is set on each service by an admin.
            </span>
          </span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : editing === 'new' ? 'Add category' : 'Save'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="px-0"
          disabled={busy}
          onClick={() => setEditing(null)}
        >
          Cancel
        </Button>
      </div>

      {editingCategory && (
        <div className="border-t border-[var(--color-border)] pt-5">
          {stats.services > 0 ? (
            /* The database will not allow this, so nothing here pretends
               otherwise — it says why, and offers the way through. */
            <div>
              <p className="label-caps text-[var(--color-muted)]">Deleting this category</p>
              <p className="mt-2 max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
                {plural(stats.services, 'service is', 'services are')} filed under{' '}
                {editingCategory.name}
                {stats.listed !== stats.services && `, ${stats.listed} of them listed`}. A
                category cannot be deleted while anything points at it — the database
                refuses rather than taking the menu down with it. Move them somewhere
                else, or leave the category here and untick <em>Listed</em> to take it
                off the site.
              </p>

              {elsewhere.length > 0 && (
                <div className="mt-4 flex flex-wrap items-end gap-3">
                  <Field
                    label="Move them to"
                    htmlFor="cat_move"
                    className="min-w-56 flex-1"
                  >
                    <Select
                      id="cat_move"
                      value={moveTarget}
                      onChange={(e) => setMoveTarget(e.target.value)}
                    >
                      <option value="">Choose a category…</option>
                      {elsewhere.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.is_active ? '' : ' (hidden)'}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={busy || !moveTarget}
                    onClick={() => moveServices(editingCategory)}
                  >
                    Move {plural(stats.services, 'service', 'services')}
                  </Button>
                </div>
              )}
            </div>
          ) : confirmDelete ? (
            <div>
              <p className="label-caps text-[var(--color-muted)]">
                Delete {editingCategory.name}?
              </p>
              <ul className="mt-2 max-w-prose list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--color-muted)]">
                <li>
                  No service is filed here, so nothing on the menu changes and no booking
                  is affected.
                </li>
                <li>
                  The page at <span className="text-[var(--color-foreground)]">/services/{editingCategory.slug}</span>{' '}
                  stops existing. Any link to it that has been shared will 404.
                </li>
                {stats.schedules > 0 && (
                  <li>
                    {plural(stats.schedules, 'reminder', 'reminders')} scoped to this
                    category {stats.schedules === 1 ? 'is' : 'are'} deleted with it.
                  </li>
                )}
                {stats.commission_rates > 0 && (
                  <li>
                    {plural(stats.commission_rates, 'commission rate', 'commission rates')}{' '}
                    set for this category {stats.commission_rates === 1 ? 'is' : 'are'}{' '}
                    deleted with it, and that plan falls back to its default.
                  </li>
                )}
                <li>This cannot be undone.</li>
              </ul>
              <div className="mt-4 flex items-center gap-3">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => remove(editingCategory)}
                >
                  {busy ? 'Deleting…' : 'Yes, delete it'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="px-0"
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep it
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="flex items-center gap-1.5 text-sm text-red-700 hover:underline disabled:opacity-50 dark:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
              Delete this category
            </button>
          )}
        </div>
      )}
    </div>
  )

  /* ── The list ──────────────────────────────────────────────── */

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="max-w-prose text-sm text-[var(--color-muted)]">
          {canManage
            ? 'Categories group the menu on the site and are how a client narrows the list when they book. The order here is the order they appear in.'
            : 'Categories group the menu on the site and are how a client narrows the list when they book. Changing them is a manager’s job — this is the list as clients see it ordered.'}
        </p>
        {canManage && editing !== 'new' && (
          <Button variant="subtle" size="sm" onClick={startNew}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            New category
          </Button>
        )}
      </div>

      {editing === 'new' && (
        <div className="relative mt-6">
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
          {editor}
        </div>
      )}

      {categories.length === 0 ? (
        editing === 'new' ? null : (
          <EmptyState
            className="mt-6"
            icon={FolderTree}
            title="No categories yet."
            description="Every service belongs to one, so the menu cannot be built until there is at least one here — facials, waxing, nails, corrective treatments."
            action={
              canManage ? (
                <Button variant="subtle" size="sm" onClick={startNew}>
                  <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                  New category
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <ul className="mt-6 space-y-px border border-[var(--color-border)] bg-[var(--color-border)]">
          {categories.map((category, index) => {
            const isEditing = editing === category.id
            const stat = usageOf(category.id)

            return (
              <li key={category.id} className="bg-[var(--color-surface)] p-5">
                <div className="flex flex-wrap items-start gap-4">
                  {canManage && (
                    <div className="-ml-2 flex shrink-0 flex-col">
                      <button
                        type="button"
                        onClick={() => move(index, -1)}
                        disabled={busy || index === 0}
                        aria-label={`Move ${category.name} up`}
                        className="p-1.5 text-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(index, 1)}
                        disabled={busy || index === categories.length - 1}
                        aria-label={`Move ${category.name} down`}
                        className="p-1.5 text-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                      </button>
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span
                        className={
                          category.is_active ? '' : 'text-[var(--color-muted)] line-through'
                        }
                      >
                        {category.name}
                      </span>
                      {!category.is_active && <Badge tone="neutral">Hidden</Badge>}
                      {category.is_intimate && <Badge tone="accent">18+</Badge>}
                    </p>
                    <p className="mt-1.5 text-xs text-[var(--color-muted)]">
                      /services/{category.slug} · {plural(stat.services, 'service', 'services')}
                      {stat.services > 0 &&
                        stat.listed !== stat.services &&
                        ` · ${stat.listed} listed`}
                    </p>
                    {category.description && (
                      <p className="mt-1.5 max-w-prose text-sm text-[var(--color-muted)]">
                        {category.description}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-1">
                    {/* A hidden category has no public page to open. */}
                    {category.is_active && (
                      <ButtonLink
                        href={`/services/${category.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        variant="ghost"
                        size="icon"
                      >
                        <ExternalLink className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                        <span className="sr-only">See {category.name} on the site</span>
                      </ButtonLink>
                    )}
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        onClick={() => toggleActive(category)}
                      >
                        {category.is_active ? (
                          <EyeOff className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                        ) : (
                          <Eye className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                        )}
                        <span className="sr-only">
                          {category.is_active
                            ? `Take ${category.name} off the site`
                            : `Put ${category.name} back on the site`}
                        </span>
                      </Button>
                    )}
                    {canManage && !isEditing && (
                      <Button variant="subtle" size="sm" onClick={() => startEdit(category)}>
                        Edit
                      </Button>
                    )}
                  </div>
                </div>

                {isEditing && (
                  <div className="relative mt-5">
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                      aria-label="Close"
                    >
                      <X className="h-4 w-4" strokeWidth={1.5} />
                    </button>
                    {editor}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
