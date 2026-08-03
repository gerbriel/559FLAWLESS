'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowUp,
  Boxes,
  ExternalLink,
  Eye,
  EyeOff,
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

/** A product category as this screen edits it. Handed over already in order. */
export interface ManagedProductCategory {
  id: number
  name: string
  slug: string
  description: string | null
  image_url: string | null
  sort_order: number
  is_active: boolean
}

/**
 * What else in the database points at a product category.
 *
 * Counted on the server so the delete can say what it would cost before it is
 * pressed rather than after.
 *
 * There is only one entry here, and that is the finding rather than an
 * oversight: `products.category_id` is the *only* reference to
 * `product_categories` anywhere in the schema. Nothing cascades off a product
 * category the way notification schedules and commission rates cascade off a
 * service category, so there is nothing else to warn about. The one other
 * mention — `inventory_change_requests.target_table` — is a text label beside a
 * bare `target_id bigint`, not a foreign key, so it neither blocks a delete nor
 * is taken by one; nothing in this app files a request against a category.
 */
export interface ProductCategoryUsage {
  category_id: number
  /**
   * Every product filed here: listed, back-bar-only, unlisted or archived.
   * This is the number that decides whether a delete is possible at all,
   * because a foreign key does not care whether a row is for sale.
   */
  products: number
  /** Of those, the ones a shopper can actually see — active, retail, unarchived. */
  listed: number
  /**
   * Of those, the ones archived out of the Inventory screen. Counted separately
   * because they are invisible everywhere else in the dashboard and are the
   * usual reason a category that looks empty refuses to be deleted.
   */
  archived: number
}

const NO_USAGE: Omit<ProductCategoryUsage, 'category_id'> = {
  products: 0,
  listed: 0,
  archived: 0,
}

type Draft = {
  name: string
  slug: string
  description: string
  image_url: string
  is_active: boolean
}

const BLANK: Draft = {
  name: '',
  slug: '',
  description: '',
  image_url: '',
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
 * in "back-bar" can never be typed — it vanishes the moment it is the last
 * character. So while someone is typing, only the characters a slug cannot
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
 * The same three codes the service-category screen names, because they are the
 * three this screen can actually provoke. Anything else falls through to the
 * database's own message, which is still better than nothing — but
 * `products_category_id_fkey` quoted at a receptionist is not an error message,
 * it is a shrug.
 */
/**
 * What a write that changed nothing means.
 *
 * PostgREST reports a row-level refusal on UPDATE and DELETE the same way it
 * reports a filter that matched nothing: zero rows, no error. Only INSERT
 * raises 42501, because only INSERT is checked against a policy rather than
 * filtered by one. So a screen that trusts the absence of an error will tell
 * someone their rename was saved at the exact moment the database threw it
 * away — the one lie a settings screen must not tell.
 *
 * This is not hypothetical here and it is not only about the wrong role.
 * `product_categories` has carried a read policy and nothing else since 007;
 * until 052 is run there is no write policy at any level, so *every* edit from
 * this screen comes back empty and cheerful. Each write below asks for the row
 * back and treats an empty answer as the refusal it is.
 */
const NOTHING_CHANGED =
  'Nothing changed — the database refused the edit. Product categories are manager-and-above, and that permission only exists once migration 052 has been run.'

function explain(error: PostgrestError | null, fallback: string): string {
  switch (error?.code) {
    case '23505':
      return 'Another category already uses that web address. Try a different one.'
    case '23503':
      return 'A product is still filed under this category, so the database refused to delete it. Reload the page — a product was probably moved into it while this was open.'
    case '42501':
      return 'Your account is not allowed to change product categories. Only a manager or an admin can.'
    default:
      return error?.message || fallback
  }
}

/**
 * Create, rename, reorder, hide and delete the groupings the shop is filtered
 * by.
 *
 * Deliberately the same screen as `ServiceCategoryManager`, one tab over, doing
 * the same job for the other half of the catalogue. Three things differ, and
 * each of them is a difference in the database rather than a difference of
 * taste:
 *
 * **A product category is a filter, not a page.** A service category owns
 * `/services/<slug>`; a product category is only ever `/shop?category=<slug>`.
 * So changing the address here does not 404 anything — it does something
 * quieter and slightly worse, which is show a visitor the whole shop as though
 * nothing were wrong. Said out loud next to the field.
 *
 * **Hiding does not take anything off sale.** The storefront reads the category
 * list filtered by `is_active` to build its filter row, and reads the products
 * separately. Untick Listed and the chip disappears while every product under
 * it stays in the shop's All grid, priced and buyable. That is the opposite of
 * how the service side behaves and is worth being blunt about, because
 * "hide the category" is otherwise a very reasonable guess at how to take a
 * range down.
 *
 * **A delete must never orphan a product.** `products.category_id` was written
 * `on delete set null` (007), which means that until migration 052 the database
 * would happily let a category go and quietly leave every product in it
 * uncategorised — dropped out of every filter, still for sale, with no record
 * of where it belonged. So the delete is not offered while anything is filed
 * here: the count is read on the server, the products are moved somewhere else
 * in one update, and only an empty category offers a button. 052 makes the
 * database refuse as well, which is what turns this from a convention into a
 * guarantee — the 23503 catch above is for the race where someone files a
 * product here while this page is open.
 *
 * Writes are `manager` and above. A provider or a receptionist sees the same
 * list and no controls, because a button whose only outcome is a refusal is
 * worse than no button.
 */
export function ProductCategoryManager({
  categories,
  usage,
  uncategorised,
  canManage,
}: {
  categories: ManagedProductCategory[]
  usage: ProductCategoryUsage[]
  /** Products filed under no category at all — see the note by the summary. */
  uncategorised: number
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

  function startEdit(category: ManagedProductCategory) {
    setDraft({
      name: category.name,
      slug: category.slug,
      description: category.description ?? '',
      image_url: category.image_url ?? '',
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

    // The one change on this screen that reaches outside it.
    if (
      editingCategory &&
      slug !== editingCategory.slug &&
      !confirm(
        `Move ${editingCategory.name} from /shop?category=${editingCategory.slug} to /shop?category=${slug}?\n\n` +
          'Any link to the old address stops filtering. It will not show an error — it quietly shows the whole shop instead.'
      )
    ) {
      return
    }

    const row = {
      name,
      slug,
      description: draft.description.trim() || null,
      image_url: draft.image_url.trim() || null,
      is_active: draft.is_active,
      // A new category joins the end of the filter row rather than tying with
      // whatever is already at the front.
      ...(target === 'new'
        ? { sort_order: categories.reduce((n, c) => Math.max(n, c.sort_order), 0) + 1 }
        : {}),
    }

    setBusy(true)
    const supabase = createClient()
    // `.select('id')` is what makes a refused write distinguishable from a
    // successful one — see NOTHING_CHANGED.
    const { data, error } =
      target === 'new'
        ? await supabase.from('product_categories').insert(row).select('id')
        : await supabase.from('product_categories').update(row).eq('id', target).select('id')
    setBusy(false)

    if (error) {
      toast.error(explain(error, 'Could not save that category.'))
      return
    }
    if ((data?.length ?? 0) === 0) {
      toast.error(NOTHING_CHANGED)
      return
    }

    toast.success(target === 'new' ? `${name} added.` : 'Saved.')
    setEditing(null)
    router.refresh()
  }

  /**
   * Move one place up or down the filter row.
   *
   * Every row is renumbered from 1 rather than swapping two values, because
   * `sort_order` defaults to 0 and a list where everything ties has no order to
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
        supabase
          .from('product_categories')
          .update({ sort_order: r.sort_order })
          .eq('id', r.id)
          .select('id')
      )
    )
    setBusy(false)

    const failed = results.find((r) => r.error)
    if (failed) {
      toast.error(explain(failed.error, 'Could not reorder the categories.'))
      return
    }
    if (results.some((r) => (r.data?.length ?? 0) === 0)) {
      toast.error(NOTHING_CHANGED)
      router.refresh()
      return
    }
    router.refresh()
  }

  /** The one-click version of the Listed tick in the editor. */
  async function toggleActive(category: ManagedProductCategory) {
    setBusy(true)
    const { data, error } = await createClient()
      .from('product_categories')
      .update({ is_active: !category.is_active })
      .eq('id', category.id)
      .select('id')
    setBusy(false)

    if (error) {
      toast.error(explain(error, 'Could not change that.'))
      return
    }
    if ((data?.length ?? 0) === 0) {
      toast.error(NOTHING_CHANGED)
      return
    }
    toast.success(
      category.is_active
        ? `${category.name} is off the shop’s filter row. Its products are still for sale under All.`
        : `${category.name} is back on the shop’s filter row.`
    )
    router.refresh()
  }

  /**
   * Refile every product under another category — the way out of a delete that
   * would otherwise orphan them.
   *
   * Only real categories are offered. "None" is not on this list on purpose:
   * clearing `category_id` is exactly the silent orphaning this screen exists
   * to prevent, and a product with no category drops out of every filter in the
   * shop while staying on sale.
   */
  async function moveProducts(category: ManagedProductCategory) {
    const to = Number(moveTarget)
    if (!to) {
      toast.error('Pick the category they should move to.')
      return
    }

    setBusy(true)
    const { data, error } = await createClient()
      .from('products')
      .update({ category_id: to })
      .eq('category_id', category.id)
      .select('id')
    setBusy(false)

    if (error) {
      toast.error(explain(error, 'Could not move those products.'))
      return
    }

    // The number that came back, not the number the page was rendered with.
    // A refused update and an update that found nothing left to do are the same
    // empty answer from PostgREST, and both of them make "5 products moved" a
    // sentence that did not happen.
    const moved = data?.length ?? 0
    if (moved === 0) {
      toast.error(
        'No product moved. Either they were moved already, or the database did not allow it — reload the page to see where they are.'
      )
      router.refresh()
      return
    }

    const name = categories.find((c) => c.id === to)?.name ?? 'the other category'
    toast.success(`${plural(moved, 'product', 'products')} moved to ${name}.`)
    setMoveTarget('')
    router.refresh()
  }

  async function remove(category: ManagedProductCategory) {
    setBusy(true)
    const supabase = createClient()

    /*
     * Counted again, now, rather than trusting the number this page was
     * rendered with.
     *
     * On the service side this would be belt and braces: `restrict` means the
     * database refuses a populated category and the worst a stale count can do
     * is produce a 23503. Here the failure mode is the other way round — the
     * column was written `on delete set null`, so a stale zero does not raise
     * anything, it quietly empties `category_id` on every product that was
     * filed here. Migration 052 turns that into a refusal and that is the
     * guarantee; this is what stands in for it in the window before 052 is
     * applied, and it closes the race either way.
     */
    const { count, error: countError } = await supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('category_id', category.id)

    if (countError) {
      setBusy(false)
      toast.error(
        explain(countError, 'Could not check what is filed under this category.')
      )
      return
    }

    if ((count ?? 0) > 0) {
      setBusy(false)
      setConfirmDelete(false)
      toast.error(
        `${plural(count ?? 0, 'product was', 'products were')} filed under ${category.name} while this was open, so it was not deleted. Move ${count === 1 ? 'it' : 'them'} first.`
      )
      router.refresh()
      return
    }

    const { data, error } = await supabase
      .from('product_categories')
      .delete()
      .eq('id', category.id)
      .select('id')
    setBusy(false)

    if (error) {
      toast.error(explain(error, 'Could not delete that category.'))
      return
    }
    if ((data?.length ?? 0) === 0) {
      // Nothing was deleted and nothing objected — the row is either gone
      // already or behind a policy this account does not satisfy. Saying
      // "deleted" here would leave the category on screen after a refresh with
      // no explanation for why.
      toast.error(NOTHING_CHANGED)
      router.refresh()
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

  /**
   * "5 products are filed under Cleansers, 3 of them in the shop, and 1 is
   * archived — …."
   *
   * Assembled here rather than as three conditionals inside the paragraph
   * because the sentence ends in a full stop, and a full stop that follows a
   * JSX expression on the next line arrives with a space in front of it.
   */
  const filed = editingCategory
    ? [
        `${plural(stats.products, 'product is', 'products are')} filed under ${editingCategory.name}`,
        stats.listed !== stats.products ? `, ${stats.listed} of them in the shop` : '',
        stats.archived > 0
          ? `, and ${plural(stats.archived, 'is archived', 'are archived')} — archived products do not show in Inventory but they still point at this category`
          : '',
        '.',
      ].join('')
    : ''

  const editor = (
    <div className="space-y-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" htmlFor="pcat_name" className="sm:col-span-2">
          <Input
            id="pcat_name"
            maxLength={80}
            value={draft.name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Cleansers"
          />
        </Field>

        {addressOpen ? (
          <Field
            label="Web address"
            htmlFor="pcat_slug"
            className="sm:col-span-2"
            hint={
              editingCategory
                ? 'A link to the old address stops filtering. It shows the whole shop rather than an error, which is quieter and harder to notice.'
                : 'Lowercase letters, numbers and hyphens. Chosen once; renaming the category later leaves it alone.'
            }
          >
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-sm text-[var(--color-muted)]">
                /shop?category=
              </span>
              <Input
                id="pcat_slug"
                maxLength={80}
                value={draft.slug}
                onChange={(e) => {
                  setSlugTouched(true)
                  setDraft((d) => ({ ...d, slug: slugTyping(e.target.value) }))
                }}
                placeholder="cleansers"
              />
            </div>
          </Field>
        ) : (
          <div className="sm:col-span-2">
            <p className="label-caps mb-2 text-[var(--color-muted)]">Web address</p>
            <p className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-[var(--color-muted)]">/shop?category={draft.slug}</span>
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
              Renaming the category does not move the address. That is on purpose:
              this is what a client has been sent.
            </p>
          </div>
        )}

        <Field
          label="Description"
          htmlFor="pcat_desc"
          className="sm:col-span-2"
          hint="For the shop and for whoever is filing a product. The shop does not print it yet."
        >
          <Textarea
            id="pcat_desc"
            rows={2}
            maxLength={400}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </Field>

        <Field
          label="Picture"
          htmlFor="pcat_img"
          className="sm:col-span-2"
          hint="A link to a photograph for this category. Stored, but nothing on the shop shows it today — the filter row is text."
        >
          <Input
            id="pcat_img"
            value={draft.image_url}
            onChange={(e) => setDraft((d) => ({ ...d, image_url: e.target.value }))}
            placeholder="https://…"
          />
        </Field>
      </div>

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
            Unticking takes the category off the shop’s filter row. It does not take
            anything off sale — every product under it stays in the shop under{' '}
            <em>All</em>, at the same price. To stop selling something, unlist the
            product itself in Inventory.
          </span>
        </span>
      </label>

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
          {stats.products > 0 ? (
            /* Deleting now would leave these products with no category at all,
               so nothing here pretends otherwise — it says why, and offers the
               way through. */
            <div>
              <p className="label-caps text-[var(--color-muted)]">Deleting this category</p>
              <p className="mt-2 max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
                {filed} They have to go somewhere before it can be deleted: a product
                with no category drops out of every filter in the shop while staying
                on sale, which is worse than the category simply being here. Move
                them, or leave the category and untick <em>Listed</em> to take it off
                the filter row.
              </p>

              {elsewhere.length > 0 ? (
                <div className="mt-4 flex flex-wrap items-end gap-3">
                  <Field
                    label="Move them to"
                    htmlFor="pcat_move"
                    className="min-w-56 flex-1"
                  >
                    <Select
                      id="pcat_move"
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
                    onClick={() => moveProducts(editingCategory)}
                  >
                    Move {plural(stats.products, 'product', 'products')}
                  </Button>
                </div>
              ) : (
                <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
                  This is the only category there is, so there is nowhere to move them
                  to. Add another one first, then come back.
                </p>
              )}
            </div>
          ) : confirmDelete ? (
            <div>
              <p className="label-caps text-[var(--color-muted)]">
                Delete {editingCategory.name}?
              </p>
              <ul className="mt-2 max-w-prose list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--color-muted)]">
                <li>
                  No product is filed here, so nothing in the shop changes, no price
                  moves and no order is affected.
                </li>
                <li>
                  The filter at{' '}
                  <span className="text-[var(--color-foreground)]">
                    /shop?category={editingCategory.slug}
                  </span>{' '}
                  stops existing. A link to it that has been shared will show the whole
                  shop rather than an error.
                </li>
                <li>
                  Nothing else in the database points at a product category, so nothing
                  is taken along quietly with it.
                </li>
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
            ? 'Categories are the filter row across the top of the shop, and how a product is found on the shelf. The order here is the order they appear in.'
            : 'Categories are the filter row across the top of the shop, and how a product is found on the shelf. Changing them is a manager’s job — this is the list as clients see it ordered.'}
        </p>
        {canManage && editing !== 'new' && (
          <Button variant="subtle" size="sm" onClick={startNew}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            New category
          </Button>
        )}
      </div>

      {/* A product may have no category — the column is nullable and always has
          been. Saying how many is the only way anyone finds out, because an
          uncategorised product is invisible under every filter while sitting in
          the shop as normal. */}
      {uncategorised > 0 && (
        <p className="mt-4 max-w-prose text-sm text-[var(--color-muted)]">
          {plural(uncategorised, 'product is', 'products are')} filed under no category
          at all. {uncategorised === 1 ? 'It shows' : 'They show'} in the shop under{' '}
          <em>All</em> and under no filter. Give{' '}
          {uncategorised === 1 ? 'it a category' : 'them a category'} in Inventory.
        </p>
      )}

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
            icon={Boxes}
            title="No product categories yet."
            description="Without one the shop has no filter row and everything sits in a single list — cleansers, serums, sun care, back bar."
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
                    </p>
                    <p className="mt-1.5 text-xs text-[var(--color-muted)]">
                      /shop?category={category.slug} ·{' '}
                      {plural(stat.products, 'product', 'products')}
                      {stat.products > 0 &&
                        stat.listed !== stat.products &&
                        ` · ${stat.listed} in the shop`}
                      {stat.archived > 0 && ` · ${stat.archived} archived`}
                    </p>
                    {category.description && (
                      <p className="mt-1.5 max-w-prose text-sm text-[var(--color-muted)]">
                        {category.description}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-1">
                    {/* A hidden category has no chip on the shop to open. */}
                    {category.is_active && (
                      <ButtonLink
                        href={`/shop?category=${category.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        variant="ghost"
                        size="icon"
                      >
                        <ExternalLink className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                        <span className="sr-only">See {category.name} in the shop</span>
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
                            ? `Take ${category.name} off the shop’s filter row`
                            : `Put ${category.name} back on the shop’s filter row`}
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
