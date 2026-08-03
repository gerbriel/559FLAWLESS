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
  Lock,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Button, ButtonLink } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/dashboard'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import {
  categoryFormLinkIsTickable,
  formLinkForCategory,
  removingCategoryWouldTargetEveryone,
} from '@/lib/forms'
import { formatMoney } from '@/lib/utils'
import type { Service } from '@/types/database'
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

/**
 * One service, as far as this screen is concerned: which category it is filed
 * under, and where every booking gate currently stands on it.
 *
 * The gates are read here and written here, but they are not stored here.
 * There is no category-level copy of any of them and there must not be — see
 * the booking-rules block below for why.
 */
export interface CategoryServiceGates {
  id: number
  category_id: number
  name: string
  is_active: boolean
  /** Only for the deposit: one may never exceed the price of its own service. */
  price_cents: number
  is_intimate: boolean
  requires_age_verification: boolean
  min_age: number
  requires_consultation: boolean
  requires_booking_approval: boolean
  patch_test_hours: number
  deposit_cents: number
  cancellation_window_hours: number
}

/**
 * A consent or intake form, as the category picker needs it.
 *
 * Which forms a category requires is stored on the FORM — `consent_forms` and
 * `intake_forms` both carry `category_ids`, and `formApplies` reads it as one
 * of the routes a requirement can arrive by. So this screen writes that same
 * array rather than keeping a list of its own: the Forms screens, the service
 * modal and this panel are three views of one answer, which is the only
 * arrangement in which they cannot drift.
 */
export interface CategoryFormTemplate {
  kind: 'consent' | 'intake'
  id: number
  title: string
  service_ids: number[]
  category_ids: number[]
}

/** Unique across the two tables, whose ids overlap. */
const templateKey = (t: { kind: string; id: number }) => `${t.kind}:${t.id}`

const NO_SERVICES: readonly CategoryServiceGates[] = []

/* ── Booking gates ────────────────────────────────────────────
 *
 * Every one of these is a column on `services`. Nothing on this screen stores
 * a category-level copy, and adding one is the mistake this block exists to
 * avoid: two places to look, and "why does this service need a patch test?"
 * answerable only by knowing which layer won. What the category offers instead
 * is a view across its services and one explicit action that writes the same
 * value to each of them — after which each service owns its answer again, as
 * it did before.
 *
 * `admin` mirrors migration 022's `services_guard_gates()` trigger, column by
 * column. Seven columns are named there and are refused from anyone but an
 * admin; `requires_booking_approval` arrived later with 036 and is not in the
 * guard, so 022's "manager writes services" policy is the whole of its
 * requirement. Gating it at admin as well would be inventing a rule the
 * database does not have, and a control the database refuses is the pattern
 * this codebase has been removing.
 */

type BoolGateKey =
  | 'is_intimate'
  | 'requires_age_verification'
  | 'requires_consultation'
  | 'requires_booking_approval'

type NumberGateKey =
  | 'min_age'
  | 'patch_test_hours'
  | 'deposit_cents'
  | 'cancellation_window_hours'

type GateKey = BoolGateKey | NumberGateKey

type GatePatch = Partial<Service>

type Gate =
  | {
      kind: 'bool'
      column: BoolGateKey
      label: string
      hint: string
      admin: boolean
      /** How each value reads in a summary and in the confirmation. */
      on: string
      off: string
      patch: (value: boolean) => GatePatch
    }
  | {
      kind: 'number'
      column: NumberGateKey
      label: string
      hint: string
      admin: boolean
      /** Dollars in the box, cents in the column. */
      money?: true
      min: number
      max: number
      /** The column's own default, used only when nothing is filed here yet. */
      fallback: number
      format: (value: number) => string
      patch: (value: number) => GatePatch
    }

const GATES: readonly Gate[] = [
  {
    kind: 'bool',
    column: 'requires_age_verification',
    label: 'Age must be confirmed before booking',
    hint: 'The client attests to their age at booking and it is recorded on the appointment.',
    admin: true,
    on: 'required',
    off: 'not required',
    patch: (value) => ({ requires_age_verification: value }),
  },
  {
    kind: 'number',
    column: 'min_age',
    label: 'Minimum age',
    hint: 'The age that attestation is checked against.',
    admin: true,
    min: 0,
    max: 99,
    fallback: 18,
    format: (value) => `${value}`,
    patch: (value) => ({ min_age: value }),
  },
  {
    kind: 'bool',
    column: 'is_intimate',
    label: 'Intimate service',
    hint: 'The gate on the service itself — plain clinical handling, and no photograph without separate written consent. Not the same switch as the 18+ label on this category above.',
    admin: true,
    on: 'yes',
    off: 'no',
    patch: (value) => ({ is_intimate: value }),
  },
  {
    kind: 'number',
    column: 'patch_test_hours',
    label: 'Patch test',
    hint: 'Hours beforehand. 0 for none.',
    admin: true,
    min: 0,
    max: 720,
    fallback: 0,
    format: (value) => (value === 0 ? 'none' : `${value} ${value === 1 ? 'hour' : 'hours'}`),
    patch: (value) => ({ patch_test_hours: value }),
  },
  {
    kind: 'bool',
    column: 'requires_consultation',
    label: 'Consultation first',
    hint: 'Cannot be booked directly online; the client asks for a consultation instead.',
    admin: true,
    on: 'required',
    off: 'not required',
    patch: (value) => ({ requires_consultation: value }),
  },
  {
    kind: 'number',
    column: 'deposit_cents',
    label: 'Deposit',
    hint: 'In dollars. 0 for none. A deposit is never applied to a service priced below it.',
    admin: true,
    money: true,
    min: 0,
    max: 100_000_00,
    fallback: 0,
    format: (value) => (value === 0 ? 'none' : formatMoney(value)),
    patch: (value) => ({ deposit_cents: value }),
  },
  {
    kind: 'number',
    column: 'cancellation_window_hours',
    label: 'Cancellation window',
    hint: 'Hours before the appointment. Cancelling later forfeits the deposit.',
    admin: true,
    min: 0,
    max: 720,
    fallback: 24,
    format: (value) => (value === 0 ? 'none' : `${value} ${value === 1 ? 'hour' : 'hours'}`),
    patch: (value) => ({ cancellation_window_hours: value }),
  },
  {
    kind: 'bool',
    column: 'requires_booking_approval',
    label: 'Booking needs approving',
    hint: 'The appointment lands in the approvals queue instead of being confirmed straight away.',
    // Added by 036, after 022's trigger was written, and deliberately not added
    // to it. A manager may set this one.
    admin: false,
    on: 'yes',
    off: 'no',
    patch: (value) => ({ requires_booking_approval: value }),
  },
]

/**
 * What one apply actually did.
 *
 * Each service is its own UPDATE and the browser has no transaction to wrap
 * them in, so a run can half-succeed. Saying "applied" over the top of that
 * would be the useful half of a lie: the summary above would still show mixed,
 * and nothing would explain why.
 */
type GateReport = {
  /** What was being applied, for the heading. */
  what: string
  changed: number
  /** Services the write did not land on, and what the database said. */
  failed: { id: number; name: string; reason: string }[]
  /** Services never attempted, and why not. */
  skipped: { id: number; name: string; reason: string }[]
}

/**
 * Every distinct value of one gate across a set of services, commonest first.
 *
 * One entry means they agree. More than one means the category is mixed, and
 * that is the state this screen exists to make visible — a mixed gate rendered
 * as an unticked box is a control that silently switches the odd one out.
 */
function gateSpread(
  list: readonly CategoryServiceGates[],
  column: GateKey
): { value: boolean | number; count: number }[] {
  const counts = new Map<boolean | number, number>()
  for (const service of list) {
    const value = service[column]
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || Number(a.value) - Number(b.value))
}

/** How one value of one gate reads in a sentence. */
function gateValueLabel(gate: Gate, value: boolean | number): string {
  return gate.kind === 'bool'
    ? value
      ? gate.on
      : gate.off
    : gate.format(Number(value))
}

/**
 * What is in the box, as the column would store it. Null if it is not a value
 * the column can hold.
 *
 * An empty box is one of those nulls, and deliberately: `Number('')` is 0, so
 * without this a cleared field — the first keystroke of changing 24 to 48 — is
 * a valid zero. "Apply (4)" lights up offering to write no cancellation window,
 * or a minimum age of 0, across a whole category, from a control that looks
 * blank. A value not yet typed is not a value.
 *
 * Money is the only one that is not what was typed: dollars in, integer cents
 * out, rounded once here and never arithmetic'd again.
 */
function parseGate(gate: Extract<Gate, { kind: 'number' }>, raw: string): number | null {
  const typed = raw.trim()
  if (typed === '') return null

  if (gate.money) {
    const dollars = Number(typed.replace(/[$,\s]/g, ''))
    if (!Number.isFinite(dollars) || dollars < 0) return null
    const cents = Math.round(dollars * 100)
    return cents > gate.max ? null : cents
  }
  const n = Number(typed)
  if (!Number.isInteger(n) || n < gate.min || n > gate.max) return null
  return n
}

/**
 * Cents into the dollars box — the inverse of `parseGate`, not a rendering.
 * `formatMoney` stays the only place money becomes something to read.
 */
const dollarsInput = (cents: number) => (cents / 100).toFixed(2)

/** What the box starts at: whatever most of the category already says. */
function seedGateDrafts(list: readonly CategoryServiceGates[]): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const gate of GATES) {
    if (gate.kind !== 'number') continue
    const top = gateSpread(list, gate.column)[0]
    const value = typeof top?.value === 'number' ? top.value : gate.fallback
    drafts[gate.column] = gate.money ? dollarsInput(value) : String(value)
  }
  return drafts
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
 * The same, for a write to a service rather than to a category.
 *
 * 022's trigger raises a plpgsql exception (P0001) whose message already names
 * the rule, so that one is passed through as it stands. The case worth naming
 * is the silent one: an UPDATE that RLS declines matches no rows and reports no
 * error at all, which is indistinguishable from success unless the returned row
 * is checked.
 */
function explainService(error: PostgrestError | null): string {
  if (!error) {
    return 'The database declined the change without saying why — usually a permission.'
  }
  if (error.code === '42501') {
    return 'Your account is not allowed to change this service.'
  }
  return error.message || 'The database refused the change.'
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
 *
 * The forms and the booking rules underneath are two different kinds of thing
 * and are built as two different kinds of control, which is the only honest way
 * to show them side by side:
 *
 * **Forms are shared storage.** `consent_forms.category_ids` and
 * `intake_forms.category_ids` already exist and a category is already one of
 * the routes `formApplies` reads. So the tick here writes that array — the same
 * one the Forms screens write and the service modal reads. Nothing is copied.
 *
 * **Booking gates are not.** Every one of them is a column on `services` and
 * there is no category-level storage for any of them. Rather than invent one,
 * the panel shows the state across the category's services and offers to write
 * a value to each of them: one UPDATE per service, to the column that already
 * owns the answer, and nothing left behind that a later edit could contradict.
 */
export function ServiceCategoryManager({
  categories,
  usage,
  services,
  forms,
  canManage,
  isAdmin,
}: {
  categories: ManagedCategory[]
  usage: CategoryUsage[]
  /** Every service in the studio, gates included, in category order. */
  services: CategoryServiceGates[]
  /** The studio's live forms, or null when they could not be read. */
  forms: CategoryFormTemplate[] | null
  canManage: boolean
  isAdmin: boolean
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
  /** Keys of the forms ticked for this category — only ever the tickable ones. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  /** Titles the last save could not write. Empty is the normal state. */
  const [formsUnwritten, setFormsUnwritten] = useState<string[]>([])
  /**
   * Titles the last save deliberately left alone: unticking them would have
   * emptied both of the form's arrays, which reads as "asked of everyone".
   */
  const [formsRefused, setFormsRefused] = useState<string[]>([])
  /** What is in each numeric gate's box, keyed by column. */
  const [gateDrafts, setGateDrafts] = useState<Record<string, string>>({})
  /** What the last apply did not manage to do, per service. */
  const [gateReport, setGateReport] = useState<GateReport | null>(null)

  const usageFor = useMemo(
    () => new Map(usage.map((u) => [u.category_id, u])),
    [usage]
  )
  const usageOf = (id: number) => usageFor.get(id) ?? NO_USAGE

  const servicesFor = useMemo(() => {
    const map = new Map<number, CategoryServiceGates[]>()
    for (const service of services) {
      const list = map.get(service.category_id)
      if (list) list.push(service)
      else map.set(service.category_id, [service])
    }
    return map
  }, [services])
  const servicesOf = (id: number): readonly CategoryServiceGates[] =>
    servicesFor.get(id) ?? NO_SERVICES

  const editingCategory =
    typeof editing === 'number' ? categories.find((c) => c.id === editing) ?? null : null

  function startNew() {
    setDraft(BLANK)
    setSlugTouched(false)
    setAddressOpen(true)
    setConfirmDelete(false)
    setMoveTarget('')
    setPicked(new Set())
    setFormsUnwritten([])
    setFormsRefused([])
    setGateDrafts({})
    setGateReport(null)
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
    // Ticks come from the stored arrays every time the panel opens, so a
    // cancelled edit leaves nothing behind — which is what cancelling means.
    setPicked(
      new Set(
        (forms ?? [])
          .filter((f) => f.category_ids.includes(category.id))
          .map(templateKey)
      )
    )
    setFormsUnwritten([])
    setFormsRefused([])
    setGateDrafts(seedGateDrafts(servicesOf(category.id)))
    setGateReport(null)
    setEditing(category.id)
  }

  /** Typing a name fills the address in until someone types one themselves. */
  function setName(name: string) {
    setDraft((d) => ({ ...d, name, slug: slugTouched ? d.slug : slugify(name) }))
  }

  function toggleForm(key: string, on: boolean) {
    setPicked((cur) => {
      const next = new Set(cur)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  /**
   * Add or remove this category's id on each form the picker actually controls.
   *
   * Never on a studio-wide one. Both arrays empty is what makes a form
   * studio-wide, and switching that off for one category would mean writing
   * every OTHER category's id into `category_ids` — quietly redefining what all
   * of them require. Never on a form that only names services inside this
   * category either: ticking that would widen it from the few services it names
   * to every service filed here, which is not what a tick next to "required for
   * 2 of 4" looks like it does.
   *
   * Writing `category_ids` on a form that has been signed or answered is
   * allowed and does not need a new version — 026's guard trigger compares
   * `body` and 046's compares `questions`. Routing this through
   * `publish_consent_version()` would burn a version number on a change that
   * alters not one word anybody agreed to.
   *
   * One untick is refused rather than written: the one that would empty both of
   * the form's arrays, which is not a removal but the widest change the shape
   * can express. `isOnlyTarget` disables that tick before it gets here; this
   * catches the case where the arrays changed underneath us.
   *
   * Every tick is an UPDATE to a different row in a different table, so this
   * reports per form and the caller says out loud which ones did not land.
   */
  async function applyFormLinks(
    supabase: ReturnType<typeof createClient>,
    categoryId: number,
    serviceIds: readonly number[]
  ): Promise<{
    changed: number
    failed: string[]
    refused: { key: string; title: string }[]
  }> {
    const nothing = { changed: 0, failed: [] as string[], refused: [] as { key: string; title: string }[] }
    if (!forms) return nothing

    const wanted = forms
      .filter((t) => categoryFormLinkIsTickable(formLinkForCategory(t, categoryId, serviceIds).link))
      .map((template) => ({ template, on: picked.has(templateKey(template)) }))
      .filter(({ template, on }) => template.category_ids.includes(categoryId) !== on)

    if (wanted.length === 0) return nothing

    // Re-read the arrays immediately before rewriting them. The copy this page
    // was rendered with may be minutes old, and these arrays are shared — a
    // service editor or the form's own page may have changed one since. If the
    // re-read fails we fall back to the rendered copy rather than abandoning
    // the save. Both arrays, because the refusal below turns on the services.
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
        const current = stored.category_ids
        const unchanged = { key, title: template.title, ok: true, wrote: false, refused: false }

        // Somebody else already made it so. Nothing to write.
        if (current.includes(categoryId) === on) return unchanged

        const next = on
          ? [...current, categoryId]
          : current.filter((id) => id !== categoryId)

        // The one write that widens a form instead of narrowing it.
        if (!on && next.length === 0 && stored.service_ids.length === 0) {
          return { ...unchanged, refused: true }
        }

        // `is_active` and the returned row together turn two silent misfires
        // into reported ones: a form superseded by publish_consent_version()
        // since this page rendered is a different row now, and an UPDATE that
        // RLS refuses matches nothing rather than erroring. Either way no rows
        // come back, and "no rows" is a failure to say out loud.
        const { data, error } =
          template.kind === 'consent'
            ? await supabase
                .from('consent_forms')
                .update({ category_ids: next })
                .eq('id', template.id)
                .eq('is_active', true)
                .select('id')
            : await supabase
                .from('intake_forms')
                .update({ category_ids: next })
                .eq('id', template.id)
                .eq('is_active', true)
                .select('id')

        return {
          key,
          title: template.title,
          ok: !error && (data?.length ?? 0) > 0,
          wrote: true,
          refused: false,
        }
      })
    )

    return {
      changed: outcomes.filter((o) => o.ok && o.wrote).length,
      failed: outcomes.filter((o) => !o.ok).map((o) => o.title),
      refused: outcomes.filter((o) => o.refused).map((o) => ({ key: o.key, title: o.title })),
    }
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

    if (error) {
      setBusy(false)
      toast.error(explain(error, 'Could not save that category.'))
      return
    }

    // A category being created has no id yet, so no form can name it. The
    // panel says as much rather than pretending the ticks are there.
    if (target === 'new') {
      setBusy(false)
      toast.success(`${name} added.`)
      setEditing(null)
      router.refresh()
      return
    }

    const links = await applyFormLinks(supabase, target, servicesOf(target).map((s) => s.id))
    setBusy(false)

    // A refused untick left the form as it was, so the tick goes back — the
    // checkbox has to show what is stored, not what was asked for.
    if (links.refused.length > 0) {
      const keys = new Set(links.refused.map((r) => r.key))
      setPicked((cur) => new Set([...cur, ...keys]))
    }
    setFormsRefused(links.refused.map((r) => r.title))

    if (links.failed.length > 0) {
      // The category is saved and some of the forms are not. Name them, keep
      // the ticks as they were set and leave the panel open, so pressing Save
      // again retries exactly the ones that failed.
      setFormsUnwritten(links.failed)
      toast.error(
        `${name} was saved, but ${
          links.failed.length === 1 ? 'one form was' : `${links.failed.length} forms were`
        } not updated.`
      )
      router.refresh()
      return
    }
    setFormsUnwritten([])

    if (links.refused.length > 0) {
      // Saved. The panel stays open so the reason the tick came back is read
      // rather than flashed past in a toast.
      toast.error(
        `${name} was saved, but ${
          links.refused.length === 1 ? 'one form was' : `${links.refused.length} forms were`
        } left as ${links.refused.length === 1 ? 'it was' : 'they were'}.`
      )
      router.refresh()
      return
    }

    toast.success(
      'Saved.' +
        (links.changed > 0
          ? ` ${plural(links.changed, 'form', 'forms')} updated.`
          : '')
    )
    setEditing(null)
    router.refresh()
  }

  /**
   * Write one gate's value to every service filed here that does not already
   * have it.
   *
   * Nothing about this is stored on the category. It is a bulk edit of the
   * column that already owns the answer, which is why a service edited
   * afterwards simply keeps what it was given — there is no inheritance to
   * fight with, and no second place to look when one service disagrees.
   *
   * Services that already match are not touched, so the count in the
   * confirmation is the real blast radius rather than the size of the category.
   * Each service is a separate UPDATE with no transaction around it, so the
   * outcome is reported per service: a run that half-lands leaves a category
   * that is still mixed, and it has to say so.
   */
  async function applyGate(category: ManagedCategory, gate: Gate, value: boolean | number) {
    const list = servicesOf(category.id)
    const differing = list.filter((s) => s[gate.column] !== value)

    // A deposit larger than the service costs is not a stricter rule, it is a
    // broken checkout. The service editor refuses it one at a time; refusing it
    // here — by name, rather than by writing it and letting the client meet it
    // — is the same rule applied to the same column.
    const skipped =
      gate.column === 'deposit_cents' && typeof value === 'number' && value > 0
        ? differing.filter((s) => s.price_cents < value)
        : []
    const targets = differing.filter((s) => !skipped.includes(s))

    if (targets.length === 0) {
      toast.error(
        skipped.length > 0
          ? `Every service that could take that deposit already has it. ${plural(
              skipped.length,
              'service is',
              'services are'
            )} priced below it.`
          : 'Every service here already says that. Nothing to change.'
      )
      return
    }

    const reading = `${gate.label}: ${gateValueLabel(gate, value)}`
    const already = list.length - differing.length
    const lines = [
      `Apply “${reading}” to ${plural(targets.length, 'service', 'services')} in ${category.name}?`,
    ]
    if (already > 0) {
      lines.push(
        `${plural(already, 'service', 'services')} already ${
          already === 1 ? 'says' : 'say'
        } that and will not be touched.`
      )
    }
    if (skipped.length > 0) {
      lines.push(
        `${plural(skipped.length, 'service is', 'services are')} priced below that deposit ` +
          `and will be left alone: ${skipped.map((s) => s.name).join(', ')}.`
      )
    }
    lines.push(
      'This is written onto each service, not onto the category. Nothing here keeps a copy, so a service changed later keeps whatever it is given then.'
    )
    if (!confirm(lines.join('\n\n'))) return

    setBusy(true)
    const supabase = createClient()
    const patch = gate.kind === 'bool' ? gate.patch(Boolean(value)) : gate.patch(Number(value))

    const outcomes = await Promise.all(
      targets.map(async (service) => {
        // The returned row is what tells a refusal from a success: 022's
        // trigger raises, but an UPDATE that RLS declines simply matches
        // nothing and reports no error at all.
        const { data, error } = await supabase
          .from('services')
          .update(patch)
          .eq('id', service.id)
          .select('id')
        const ok = !error && (data?.length ?? 0) > 0
        return {
          id: service.id,
          name: service.name,
          ok,
          reason: explainService(error),
        }
      })
    )
    setBusy(false)

    const failed = outcomes
      .filter((o) => !o.ok)
      .map((o) => ({ id: o.id, name: o.name, reason: o.reason }))
    setGateReport({
      what: reading,
      changed: outcomes.length - failed.length,
      failed,
      skipped: skipped.map((s) => ({
        id: s.id,
        name: s.name,
        reason: `priced at ${formatMoney(s.price_cents)}, below the deposit`,
      })),
    })

    if (failed.length > 0) {
      toast.error(
        `${plural(outcomes.length - failed.length, 'service', 'services')} changed, ${
          failed.length
        } not.`
      )
    } else {
      toast.success(`${plural(outcomes.length, 'service', 'services')} updated.`)
    }
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

  const editingServices = editingCategory ? servicesOf(editingCategory.id) : NO_SERVICES

  /**
   * Every form, sorted by how it reaches this category.
   *
   * The four answers are not two, so they are not four checkboxes. Only
   * `tickable` gets one; the rest are shown for what they are.
   */
  const formLinks =
    editingCategory && forms
      ? forms.map((template) => ({
          template,
          ...formLinkForCategory(
            template,
            editingCategory.id,
            editingServices.map((s) => s.id)
          ),
        }))
      : []
  const tickableForms = formLinks.filter((l) => categoryFormLinkIsTickable(l.link))
  const studioForms = formLinks.filter((l) => l.link === 'studio')
  const partialForms = formLinks.filter((l) => l.link === 'services')

  /**
   * This category is the only thing the form names, and it names no service.
   *
   * Judged against what is STORED, not what is ticked: reverting a tick made in
   * this panel writes nothing, so there is nothing to refuse. Only a stored
   * link is at risk, and emptying it asks the form of everyone.
   */
  function isOnlyTarget(template: CategoryFormTemplate, categoryId: number): boolean {
    return (
      template.category_ids.includes(categoryId) &&
      removingCategoryWouldTargetEveryone(template, categoryId)
    )
  }

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
              clinical. It is a label, not the gate: what a client must actually confirm
              before booking is set on each service, under <em>Booking rules</em> below,
              and only an admin may change it.
            </span>
          </span>
        </label>
      </div>

      {/* ── Forms ─────────────────────────────────────────────
          Shared storage, so a shared control: the tick writes the same
          `category_ids` the Forms screens write and the service modal reads.
          Saved with the rest of the panel, because that is what it is. */}
      {editingCategory ? (
        <fieldset className="border-t border-[var(--color-border)] pt-5">
          <legend className="label-caps text-[var(--color-muted)]">
            Forms to fill in first
          </legend>

          <p className="mt-3 max-w-prose text-xs text-[var(--color-muted)]">
            The same list each form keeps of what it applies to, seen from this
            category&rsquo;s side. Ticking one here is the same switch as ticking this
            category on the form itself — every service filed here asks for it, including
            ones added later.
          </p>

          {formsUnwritten.length > 0 && (
            <div className="mt-4 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm dark:bg-[var(--color-background)]">
              <p className="text-red-700 dark:text-red-400">
                The category was saved, but these forms were not changed:
              </p>
              <ul className="mt-1.5 list-disc pl-5 text-[var(--color-muted)]">
                {formsUnwritten.map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ul>
              <p className="mt-2 text-[var(--color-muted)]">
                Each form is a separate write, so the others went through. Save again to
                retry these, or set them from the form&rsquo;s own page under Forms.
              </p>
            </div>
          )}

          {formsRefused.length > 0 && (
            <div className="mt-4 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm dark:bg-[var(--color-background)]">
              <p>These forms were left as they were:</p>
              <ul className="mt-1.5 list-disc pl-5 text-[var(--color-muted)]">
                {formsRefused.map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ul>
              <p className="mt-2 text-[var(--color-muted)]">
                This category is the only thing each of them names, and they name no
                service. A form that names nothing is asked of every client for every
                service — so removing the last one would widen it, not switch it off.
                Switch it off, or point it somewhere else, on its own page under Forms.
              </p>
            </div>
          )}

          {forms === null ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">
              The forms could not be read with your account. Everything else here still
              saves; nothing about which forms this category needs will change.
            </p>
          ) : forms.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">
              No forms are in use yet. They are written under Forms, and can be pointed at
              this category from either side once they exist.
            </p>
          ) : (
            <>
              {tickableForms.length > 0 && (
                <div className="mt-4 space-y-3">
                  {tickableForms.map(({ template }) => {
                    const key = templateKey(template)
                    // Ticked and locked: the only category it names, no service
                    // behind it. Unticking would empty both arrays, and empty
                    // means everyone.
                    const onlyTarget = isOnlyTarget(template, editingCategory.id)
                    // Named on some of these services in their own right, which
                    // unticking the category does not undo. Said here rather
                    // than discovered afterwards, when the row would reappear
                    // under "required for some of these services".
                    const namedHere = editingServices.filter((s) =>
                      template.service_ids.includes(s.id)
                    ).length
                    return (
                      <label
                        key={key}
                        className={`flex items-start gap-2.5 text-sm ${
                          onlyTarget ? '' : 'cursor-pointer'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={picked.has(key)}
                          disabled={onlyTarget || busy}
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
                              ? ' — the only category it asks. A form that names nothing is asked of everyone, so switch it off under Forms rather than here.'
                              : ''}
                            {namedHere > 0
                              ? ` It also names ${plural(
                                  namedHere,
                                  'service',
                                  'services'
                                )} here in its own right, which unticking this will not change.`
                              : ''}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}

              {/* The reason this section is worth having: a form required for
                  some of the category and not the rest. Neither ticked nor
                  unticked — ticking it would widen it to every service here,
                  which is a different decision from the one that was made. */}
              {partialForms.length > 0 && (
                <div className="mt-5 border-l-2 border-[var(--color-accent)] pl-4">
                  <p className="label-caps text-[var(--color-muted)]">
                    Required for some of these services
                  </p>
                  <ul className="mt-3 space-y-3">
                    {partialForms.map(({ template, covered, total }) => (
                      <li key={templateKey(template)} className="text-sm">
                        <span className="flex flex-wrap items-center gap-2">
                          {template.title}
                          <Badge tone="warning" size="sm">
                            {covered} of {total}
                          </Badge>
                        </span>
                        <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                          {template.kind === 'consent' ? 'Consent' : 'Intake'} — named on{' '}
                          {plural(covered, 'service', 'services')} here individually, not on
                          the category. There is no tick for that: switching it on here
                          would ask it of all {total}, which is a bigger decision than this
                          box would look like. Change it on each service, or on the
                          form&rsquo;s own page under Forms.
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {studioForms.length > 0 && (
                <div className="mt-5 border-l-2 border-[var(--color-border)] pl-4">
                  <p className="label-caps text-[var(--color-muted)]">
                    Already required, from elsewhere
                  </p>
                  <ul className="mt-3 space-y-3">
                    {studioForms.map(({ template }) => (
                      <li key={templateKey(template)} className="flex items-start gap-2.5 text-sm">
                        <Lock
                          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)]"
                          strokeWidth={1.5}
                          aria-hidden
                        />
                        <span>
                          {template.title}
                          <span className="block text-xs text-[var(--color-muted)]">
                            Asked of every service in the studio. Not switchable from one
                            category — change it on the form itself, under Forms.
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </fieldset>
      ) : (
        <p className="border-t border-[var(--color-border)] pt-5 text-xs text-[var(--color-muted)]">
          Which forms this category asks for, and the booking rules for the services in
          it, are set once it exists — a form can only name a category that has an id.
        </p>
      )}

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

      {/* ── Booking gates ─────────────────────────────────────
          No category-level storage exists for any of these and none is being
          invented. What the category can do is show the state across its
          services and write one value onto each of them. */}
      {editingCategory && (
        <div className="border-t border-[var(--color-border)] pt-5">
          <p className="label-caps text-[var(--color-muted)]">
            Booking rules for the services in here
          </p>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
            Every one of these is set on the service itself. The category keeps no copy —
            that is deliberate, so &ldquo;why does this one need a patch test?&rdquo; has
            one answer rather than two layers to reconcile. Below is where the{' '}
            {plural(editingServices.length, 'service', 'services')} filed here stand now,
            and an action that writes one value onto each of them. It happens as soon as
            you confirm it; it is not part of Save, and a service edited afterwards keeps
            whatever it is given then.
          </p>
          <p className="mt-2 max-w-prose text-xs text-[var(--color-muted)]">
            The <em>Intimate services</em> tick further up is a different thing: it is the
            18+ label on the public menu. What a client must confirm before booking is{' '}
            <em>Age must be confirmed</em> below.
          </p>
          {!isAdmin && (
            <p className="mt-2 max-w-prose text-xs text-[var(--color-muted)]">
              The rules marked <em>admin only</em> are readable here and changed by an
              admin. That is not this screen being cautious — a trigger on the services
              table refuses those columns from anyone else, so a button here would only
              ever produce a refusal.
            </p>
          )}

          {editingServices.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">
              Nothing is filed under {editingCategory.name} yet, so there is nothing to
              apply a rule to. A service picks these up from the service editor, or from
              here once it is filed.
            </p>
          ) : (
            <>
              {gateReport && (gateReport.failed.length > 0 || gateReport.skipped.length > 0) && (
                <div className="mt-4 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm dark:bg-[var(--color-background)]">
                  <p className={gateReport.failed.length > 0 ? 'text-red-700 dark:text-red-400' : ''}>
                    {gateReport.what} — {plural(gateReport.changed, 'service', 'services')}{' '}
                    changed.
                  </p>
                  {gateReport.failed.length > 0 && (
                    <>
                      <p className="mt-2 text-[var(--color-muted)]">These did not change:</p>
                      <ul className="mt-1.5 list-disc pl-5 text-[var(--color-muted)]">
                        {gateReport.failed.map((f) => (
                          <li key={f.id}>
                            {f.name} — {f.reason}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {gateReport.skipped.length > 0 && (
                    <>
                      <p className="mt-2 text-[var(--color-muted)]">These were left alone:</p>
                      <ul className="mt-1.5 list-disc pl-5 text-[var(--color-muted)]">
                        {gateReport.skipped.map((s) => (
                          <li key={s.id}>
                            {s.name} — {s.reason}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <p className="mt-2 text-[var(--color-muted)]">
                    Each service is a separate write with nothing wrapped around it, so the
                    rest went through. The counts above are live — try again, or set the odd
                    ones out from the service editor.
                  </p>
                </div>
              )}

              <div className="mt-4 space-y-4">
                {GATES.map((gate) => {
                  const spread = gateSpread(editingServices, gate.column)
                  const mixed = spread.length > 1
                  // 022's trigger, column by column — not the strictest of the
                  // seven applied to all eight.
                  const editable = gate.admin ? isAdmin : canManage

                  const summary = mixed
                    ? spread
                        .map((e) => `${gateValueLabel(gate, e.value)} on ${e.count}`)
                        .join(' · ')
                    : `${gateValueLabel(gate, spread[0].value)} — all ${plural(
                        editingServices.length,
                        'service',
                        'services'
                      )}`

                  const onNow = editingServices.filter((s) => s[gate.column] === true).length
                  const draft = gateDrafts[gate.column] ?? ''
                  const parsed = gate.kind === 'number' ? parseGate(gate, draft) : null
                  const differing =
                    parsed === null
                      ? []
                      : editingServices.filter((s) => s[gate.column] !== parsed)
                  const tooDear =
                    gate.kind === 'number' && gate.column === 'deposit_cents' && parsed !== null && parsed > 0
                      ? differing.filter((s) => s.price_cents < parsed).length
                      : 0
                  const willChange = differing.length - tooDear

                  return (
                    <div
                      key={gate.column}
                      className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-[var(--color-border)] pt-4 first:border-t-0 first:pt-0"
                    >
                      <div className="min-w-56 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm">
                          {gate.label}
                          {mixed && (
                            <Badge tone="warning" size="sm">
                              Mixed
                            </Badge>
                          )}
                          {!editable && (
                            <Badge tone="neutral" size="sm">
                              Admin only
                            </Badge>
                          )}
                        </p>
                        <p className="mt-1 text-sm">{summary}</p>
                        <p className="mt-1 max-w-prose text-xs text-[var(--color-muted)]">
                          {gate.hint}
                        </p>
                      </div>

                      {editable && (
                        <div className="shrink-0">
                          {gate.kind === 'bool' ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                variant="subtle"
                                disabled={busy || onNow === editingServices.length}
                                aria-label={`Turn ${gate.label} on for all services in ${editingCategory.name}`}
                                onClick={() => applyGate(editingCategory, gate, true)}
                              >
                                Turn on ({editingServices.length - onNow})
                              </Button>
                              <Button
                                size="sm"
                                variant="subtle"
                                disabled={busy || onNow === 0}
                                aria-label={`Turn ${gate.label} off for all services in ${editingCategory.name}`}
                                onClick={() => applyGate(editingCategory, gate, false)}
                              >
                                Turn off ({onNow})
                              </Button>
                            </div>
                          ) : (
                            <div>
                              <div className="flex items-center gap-2">
                                {gate.money && (
                                  <span className="text-sm text-[var(--color-muted)]">$</span>
                                )}
                                <Input
                                  id={`gate_${gate.column}`}
                                  className="w-24"
                                  inputMode={gate.money ? 'decimal' : 'numeric'}
                                  aria-label={`${gate.label} to apply to every service in ${editingCategory.name}`}
                                  value={draft}
                                  disabled={busy}
                                  onChange={(e) =>
                                    setGateDrafts((d) => ({ ...d, [gate.column]: e.target.value }))
                                  }
                                />
                                <Button
                                  size="sm"
                                  variant="subtle"
                                  disabled={busy || parsed === null || willChange === 0}
                                  onClick={() => {
                                    if (parsed !== null) applyGate(editingCategory, gate, parsed)
                                  }}
                                >
                                  Apply ({willChange})
                                </Button>
                              </div>
                              {parsed === null ? (
                                /* Empty is on the way to a value, not a wrong
                                   one. Apply is off either way. */
                                draft.trim() === '' ? null : (
                                  <p className="mt-1 text-right text-xs text-red-700 dark:text-red-400">
                                    Not a value this can hold.
                                  </p>
                                )
                              ) : tooDear > 0 ? (
                                <p className="mt-1 max-w-56 text-right text-xs text-[var(--color-muted)]">
                                  {plural(tooDear, 'service is', 'services are')} priced below
                                  that and will be left alone.
                                </p>
                              ) : null}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}

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

              {elsewhere.length > 0 ? (
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
              ) : (
                /* The only category there is, and it is full. Without this the
                   panel says "move them somewhere else" and then offers no way
                   to — a paragraph naming a control that is not on the screen,
                   which reads as a broken page rather than as a state. */
                <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
                  This is the only category there is, so there is nowhere to move
                  them to. Add another one first, then come back.
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

  /**
   * What is worth knowing about a category without opening it.
   *
   * Only the two states that are otherwise invisible: forms that reach every
   * service here, and anything that is inconsistent underneath. A category
   * whose services disagree about a booking rule looks exactly like one whose
   * services agree until somebody opens it, which is how it stays wrong.
   */
  function rowNotes(category: ManagedCategory): string[] {
    const list = servicesOf(category.id)
    const ids = list.map((s) => s.id)
    const notes: string[] = []

    if (forms) {
      const links = forms.map((f) => formLinkForCategory(f, category.id, ids))
      const everywhere = links.filter((l) => l.link === 'studio' || l.link === 'category').length
      if (everywhere > 0) notes.push(plural(everywhere, 'form', 'forms'))
      if (links.some((l) => l.link === 'services')) notes.push('forms vary')
    }

    if (list.length > 1 && GATES.some((g) => gateSpread(list, g.column).length > 1)) {
      notes.push('booking rules vary')
    }
    return notes
  }

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
            const notes = rowNotes(category)

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
                      {notes.length > 0 && ` · ${notes.join(' · ')}`}
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
