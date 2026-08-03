'use client'

import { useMemo, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { toast } from 'sonner'
import { Check, Clock, ExternalLink, Link2, Scissors, SearchX, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button, ButtonLink } from '@/components/ui/button'
import { EmptyState, Panel, SearchField } from '@/components/ui/dashboard'
import { FilterPills } from '@/components/ui/dashboard-client'
import {
  ServiceEditor,
  type EditableService,
  type ServiceCategoryOption,
} from '@/components/shared/ServiceEditor'
import { formatDuration, formatMoney, formatServicePrice } from '@/lib/utils'

/** A category, with the fields the rail and the thumbnails need. */
export interface CatalogueCategory {
  id: number
  name: string
  slug: string
  image_url: string | null
  is_active: boolean
}

/**
 * A service row. `services.image_url` is its own photograph where the studio
 * has one; most do not, and the category picture stands in.
 */
export type CatalogueService = EditableService & { image_url: string | null }

/**
 * The square picture at the left of a row.
 *
 * Not the kit's `Thumb`: that contains rather than crops, which is right for a
 * bottle photographed on nothing and wrong for a treatment-room photograph,
 * which wants a square crop of the middle.
 */
function ServiceThumb({ src }: { src: string | null }) {
  return (
    <span
      data-ui="tile"
      className="relative block h-14 w-14 shrink-0 overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-background)]"
    >
      {src ? (
        <Image src={src} alt="" fill sizes="56px" className="object-cover" />
      ) : (
        <Scissors
          className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-[var(--color-muted)]"
          strokeWidth={1.25}
          aria-hidden
        />
      )}
    </span>
  )
}

/**
 * The link you paste into a text message: the booking flow, opened on this
 * service. `/book?service=<slug>` is a real entry point — the flow reads the
 * slug and starts there — so this copies what the client will actually follow.
 */
function CopyBookingLink({ slug, name }: { slug: string; name: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    const url = `${window.location.origin}/book?service=${slug}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast.success('Booking link copied.')
    } catch {
      // Clipboard permission can be refused; the link is short enough to say.
      toast.error(`Could not copy. The link is ${url}`)
    }
  }

  return (
    <Button type="button" variant="ghost" size="icon" onClick={copy}>
      {copied ? (
        <Check className="h-4 w-4 text-emerald-600" strokeWidth={2.5} aria-hidden />
      ) : (
        <Link2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      )}
      <span className="sr-only">Copy the booking link for {name}</span>
    </Button>
  )
}

/**
 * The service menu: search and category pills over a stack of cards, with a
 * rail beside it for the things that describe the menu rather than sit in it.
 *
 * Still grouped by category, because that is how it reads on the public site —
 * seeing the same shape here makes it obvious what a price change will look
 * like to a client. Below `lg` the rail drops under the list rather than
 * squeezing it.
 */
export function ServicesCatalogue({
  services,
  categories,
  canEdit,
  isAdmin,
}: {
  services: CatalogueService[]
  categories: CatalogueCategory[]
  canEdit: boolean
  isAdmin: boolean
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')

  const options: ServiceCategoryOption[] = useMemo(
    () => categories.map((c) => ({ id: c.id, name: c.name })),
    [categories]
  )

  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  /** How many services sit under each category, before any filtering. */
  const counts = useMemo(() => {
    const tally = new Map<number, number>()
    for (const s of services) tally.set(s.category_id, (tally.get(s.category_id) ?? 0) + 1)
    return tally
  }, [services])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()

    const matches = (s: CatalogueService) => {
      if (filter !== 'all' && String(s.category_id) !== filter) return false
      if (!needle) return true
      const category = byId.get(s.category_id)?.name ?? ''
      return (
        s.name.toLowerCase().includes(needle) ||
        (s.description ?? '').toLowerCase().includes(needle) ||
        category.toLowerCase().includes(needle)
      )
    }

    const known = categories.map((cat) => ({
      key: String(cat.id),
      name: cat.name,
      hidden: !cat.is_active,
      image_url: cat.image_url,
      rows: services.filter((s) => s.category_id === cat.id && matches(s)),
    }))

    // A service whose category has gone would otherwise be absent from this
    // page altogether, which is precisely the moment you need to find it.
    const orphans = services.filter((s) => !byId.has(s.category_id) && matches(s))

    return orphans.length > 0
      ? [...known, { key: 'other', name: 'Uncategorised', hidden: false, image_url: null, rows: orphans }]
      : known
  }, [byId, categories, filter, query, services])

  const shown = groups.reduce((n, g) => n + g.rows.length, 0)

  const pills = [
    { value: 'all', label: 'All', count: services.length },
    ...categories.map((c) => ({
      value: String(c.id),
      label: c.name,
      count: counts.get(c.id) ?? 0,
    })),
  ]

  // The gates that decide whether a booking is allowed to happen at all. Worth
  // a glance in one place; each one is still set on the service itself.
  const gates = [
    {
      label: 'Age confirmed before booking',
      n: services.filter((s) => s.requires_age_verification).length,
    },
    { label: 'Patch test first', n: services.filter((s) => s.patch_test_hours > 0).length },
    { label: 'Consultation first', n: services.filter((s) => s.requires_consultation).length },
    { label: 'Deposit to hold the time', n: services.filter((s) => s.deposit_cents > 0).length },
  ].filter((g) => g.n > 0)

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
      <div className="min-w-0">
        <SearchField
          label="Search by service name, description, or category"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {categories.length > 0 && (
          <FilterPills
            className="mt-4"
            label="Category"
            options={pills}
            value={filter}
            onChange={setFilter}
          />
        )}

        {shown === 0 ? (
          services.length === 0 ? (
            <EmptyState
              className="mt-6"
              icon={Scissors}
              title="No services yet."
              description="The menu is what clients book from, so nothing can be booked until something is listed here."
              action={
                canEdit && options.length > 0 ? (
                  <ServiceEditor categories={options} isAdmin={isAdmin} />
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              className="mt-6"
              icon={SearchX}
              title="Nothing matches that."
              description="Names, descriptions and category names are searched. Try fewer words."
              action={
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => {
                    setQuery('')
                    setFilter('all')
                  }}
                >
                  Clear the search
                </Button>
              }
            />
          )
        ) : (
          groups.map((group) =>
            group.rows.length === 0 ? null : (
              <section key={group.key} className="mt-8">
                <div className="flex flex-wrap items-baseline gap-3">
                  <h2 className="display text-xl">{group.name}</h2>
                  {group.hidden && <Badge tone="neutral">Category hidden</Badge>}
                  <span className="text-xs tabular-nums text-[var(--color-muted)]">
                    {group.rows.length}
                  </span>
                </div>

                <ul className="mt-3 space-y-2.5">
                  {group.rows.map((s) => (
                    <li key={s.id}>
                      <Panel className="flex flex-wrap items-start gap-4 p-4 sm:flex-nowrap sm:p-5">
                        <ServiceThumb src={s.image_url ?? group.image_url} />

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={
                                s.is_active ? '' : 'text-[var(--color-muted)] line-through'
                              }
                            >
                              {s.name}
                            </span>
                            {!s.is_active && <Badge tone="neutral">Not listed</Badge>}
                            {s.is_featured && <Badge tone="accent">Featured</Badge>}
                            {s.requires_age_verification && (
                              <Badge tone="warning">
                                <ShieldCheck className="h-3 w-3" strokeWidth={2} />
                                {s.min_age}+
                              </Badge>
                            )}
                            {s.requires_consultation && (
                              <Badge tone="neutral">Consult first</Badge>
                            )}
                            {s.patch_test_hours > 0 && (
                              <Badge tone="neutral">Patch test {s.patch_test_hours}h</Badge>
                            )}
                          </div>

                          {/* Duration and price both come from the row; the
                              cents become a string exactly once, in
                              formatServicePrice → formatMoney. */}
                          <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[var(--color-muted)]">
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" strokeWidth={1.75} aria-hidden />
                              {formatDuration(s.duration_minutes)}
                              {s.buffer_minutes > 0 && ` + ${s.buffer_minutes} turnaround`}
                            </span>
                            <span aria-hidden>·</span>
                            <span className="tabular-nums text-[var(--color-foreground)]">
                              {formatServicePrice(s)}
                            </span>
                            {s.deposit_cents > 0 && (
                              <>
                                <span aria-hidden>·</span>
                                <span className="tabular-nums">
                                  {formatMoney(s.deposit_cents)} deposit
                                </span>
                              </>
                            )}
                          </p>

                          {s.description && (
                            <p className="mt-1.5 max-w-prose text-sm text-[var(--color-muted)]">
                              {s.description}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          {/* A service that is not listed has no public page
                              and cannot be booked, so there is no link to
                              hand out for it. */}
                          {s.is_active && <CopyBookingLink slug={s.slug} name={s.name} />}
                          {/* The public URL is /services/<category>/<service>,
                              so a service with no category has nowhere to go. */}
                          {s.is_active && byId.get(s.category_id) && (
                            <ButtonLink
                              href={`/services/${byId.get(s.category_id)?.slug}/${s.slug}`}
                              target="_blank"
                              rel="noreferrer"
                              variant="ghost"
                              size="icon"
                            >
                              <ExternalLink className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                              <span className="sr-only">See {s.name} on the site</span>
                            </ButtonLink>
                          )}
                          {canEdit && (
                            <ServiceEditor service={s} categories={options} isAdmin={isAdmin} />
                          )}
                        </div>
                      </Panel>
                    </li>
                  ))}
                </ul>
              </section>
            )
          )
        )}
      </div>

      <aside className="space-y-4">
        <Panel className="p-6">
          <h2 className="display text-xl">Categories</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">
            Categories group the menu on the site and are how a client narrows the list when
            they book. A hidden category, or one with nothing listed under it, does not appear
            publicly.
          </p>

          {categories.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">No categories yet.</p>
          ) : (
            <ul className="mt-4 divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
              {categories.map((cat) => (
                <li key={cat.id} className="flex items-center gap-2.5 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{cat.name}</span>
                  {!cat.is_active && (
                    <Badge tone="neutral" size="sm">
                      Hidden
                    </Badge>
                  )}
                  <span className="tabular-nums text-[var(--color-muted)]">
                    {counts.get(cat.id) ?? 0}
                  </span>
                  {cat.is_active && (
                    <ButtonLink
                      href={`/services/${cat.slug}`}
                      target="_blank"
                      rel="noreferrer"
                      variant="ghost"
                      size="icon"
                      className="-mr-2"
                    >
                      <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                      <span className="sr-only">See {cat.name} on the site</span>
                    </ButtonLink>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-4 text-xs leading-relaxed text-[var(--color-muted)]">
            A service&rsquo;s category is chosen when you edit it.{' '}
            <Link
              href="/dashboard/services/categories"
              className="underline underline-offset-4 hover:text-[var(--color-foreground)]"
            >
              Categories
            </Link>{' '}
            is where they are added, renamed, reordered and hidden.
          </p>
        </Panel>

        {gates.length > 0 && (
          <Panel className="p-6">
            <h2 className="display text-xl">Booking gates</h2>
            <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">
              What a client has to clear before a time can be held. Set per service by an admin,
              and enforced by the database rather than by the booking screen.
            </p>
            <ul className="mt-4 divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
              {gates.map((gate) => (
                <li key={gate.label} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="min-w-0 flex-1">{gate.label}</span>
                  <span className="tabular-nums text-[var(--color-muted)]">{gate.n}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {canEdit && !isAdmin && (
          <Panel className="bg-[var(--color-clay-soft)] p-6 dark:bg-[var(--color-surface)]">
            <h2 className="display text-xl">What you can change</h2>
            <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">
              You can edit names, prices, durations and copy. Age gates, patch tests and deposits
              are set by an admin.
            </p>
          </Panel>
        )}
      </aside>
    </div>
  )
}
