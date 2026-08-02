import Link from 'next/link'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { ArrowLeft, Download } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { resolveReportShell, type ReportSearchParams } from '@/lib/reports/shell'
import { roleAtLeast } from '@/lib/reports/types'
import {
  ROW_CAP,
  SUBJECTS,
  findSubject,
  reportsDb,
  runCustomQuery,
  sanitiseDefinition,
  type CustomDefinition,
} from '@/lib/reports/custom'
import { ReportFilters } from '@/components/shared/ReportFilters'
import { ReportTable } from '@/components/shared/ReportTable'
import { Button } from '@/components/ui/button'
import { Input, Label, Select } from '@/components/ui/field'

export const dynamic = 'force-dynamic'

type Search = ReportSearchParams & Record<string, string | string[] | undefined>

interface Props {
  searchParams: Promise<Search>
}

/** A repeated query param arrives as an array; a single one as a string. */
function many(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Read the definition out of the URL. Everything is re-checked by sanitise. */
function definitionFromSearch(search: Search): CustomDefinition | null {
  const subject = findSubject(one(search.subject))
  if (!subject) return null

  const filters: Record<string, string> = {}
  for (const f of subject.filters) {
    const value = one(search[`f_${f.key}`])
    if (value) filters[f.key] = value
  }

  return sanitiseDefinition({
    subject: subject.key,
    columns: many(search.cols),
    filters,
    groupBy: one(search.group) ?? null,
    sort: one(search.sort) ?? null,
    sortDir: one(search.dir) === 'asc' ? 'asc' : 'desc',
  })
}

export default async function CustomReportPage({ searchParams }: Props) {
  const search = await searchParams
  const shell = await resolveReportShell(search)
  if (!shell) redirect('/login?next=/dashboard/reports/custom')

  // The builder reaches money, vendors and lifetime value across the whole
  // business. That is a manager's view, and the subjects say so individually
  // too — this is the outer gate.
  if (!roleAtLeast(shell.viewer.role, 'manager')) redirect('/dashboard')

  const supabase = await createClient()
  const db = reportsDb(supabase)

  // ── Saved definitions ────────────────────────────────────
  const { data: savedRows } = await db
    .from('saved_reports')
    .select('id, name, definition, is_shared, created_by, created_at')
    .order('created_at', { ascending: false })
    .limit(50)

  const saved = (savedRows ?? []) as {
    id: number
    name: string
    definition: Record<string, unknown>
    is_shared: boolean
    created_by: string | null
  }[]

  // A saved report is a starting point, not a stored query: its definition goes
  // through the same allow-list as anything typed into the URL, so a row that
  // was edited in the database to name a column the builder does not offer
  // simply loses that column.
  const loadId = one(search.load)
  const loaded = loadId ? saved.find((s) => String(s.id) === loadId) : undefined

  const definition =
    definitionFromSearch(search) ??
    (loaded ? sanitiseDefinition(loaded.definition) : null) ??
    sanitiseDefinition({ subject: SUBJECTS[0].key, columns: [], filters: {} })!

  const subject = findSubject(definition.subject)!

  // ── Run it ───────────────────────────────────────────────
  const compiled = await runCustomQuery(supabase, subject, definition, {
    from: shell.ctx.from,
    to: shell.ctx.to,
    timeZone: shell.ctx.timeZone,
    locationId: shell.ctx.locationId,
    providerId: shell.ctx.providerId,
  })
  const { error, truncated } = compiled

  // ── Links and hidden state ───────────────────────────────
  const definitionParams: Record<string, string | string[] | undefined> = {
    subject: definition.subject,
    cols: definition.columns,
    group: definition.groupBy ?? undefined,
    sort: definition.sort ?? undefined,
    dir: definition.sortDir,
    ...Object.fromEntries(
      Object.entries(definition.filters).map(([k, v]) => [`f_${k}`, v])
    ),
  }

  const exportQuery = new URLSearchParams()
  for (const [k, v] of Object.entries(definitionParams)) {
    for (const item of Array.isArray(v) ? v : v === undefined ? [] : [v]) {
      exportQuery.append(k, item)
    }
  }
  exportQuery.set('preset', shell.range.preset)
  if (shell.range.preset === 'custom') {
    exportQuery.set('from', shell.range.from)
    exportQuery.set('to', shell.range.to)
  }
  if (shell.ctx.locationId !== null) exportQuery.set('location', String(shell.ctx.locationId))

  // ── Server actions ───────────────────────────────────────
  async function saveDefinition(formData: FormData) {
    'use server'
    const name = String(formData.get('name') ?? '').trim()
    const raw = String(formData.get('definition') ?? '')
    if (!name) return

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    // Store only what the builder can actually run. A definition is saved after
    // the allow-list, never before it.
    const clean = sanitiseDefinition(parsed)
    if (!clean) return

    const client = await createClient()
    const {
      data: { user },
    } = await client.auth.getUser()
    if (!user) return

    // RLS re-checks all of this; `created_by` is set here because the policy
    // requires it to equal auth.uid() and will reject anything else.
    await reportsDb(client)
      .from('saved_reports')
      .insert({
        name: name.slice(0, 120),
        definition: clean,
        is_shared: formData.get('is_shared') === 'on',
        created_by: user.id,
      })

    revalidatePath('/dashboard/reports/custom')
  }

  async function deleteDefinition(formData: FormData) {
    'use server'
    const id = Number(formData.get('id'))
    if (!Number.isInteger(id)) return
    const client = await createClient()
    // No ownership check here on purpose — the delete policy is the check, and
    // duplicating it in TypeScript would only create a second thing to drift.
    await reportsDb(client).from('saved_reports').delete().eq('id', id)
    revalidatePath('/dashboard/reports/custom')
  }

  const groupable = subject.columns.filter((c) => c.groupable)
  const sortable = definition.groupBy
    ? [
        { key: definition.groupBy, label: groupable.find((c) => c.key === definition.groupBy)?.label ?? '' },
        { key: 'row_count', label: 'Rows' },
        ...subject.columns.filter((c) => c.aggregate && definition.columns.includes(c.key)),
      ]
    : subject.columns.filter((c) => definition.columns.includes(c.key))

  return (
    <div>
      <Link
        href="/dashboard/reports"
        className="label-caps inline-flex items-center gap-2 text-[var(--color-muted)] hover:text-[var(--color-accent)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
        All reports
      </Link>

      <div className="mt-5 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="display text-3xl">Custom report</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">
            Pick a subject, choose columns, filter, group and sort. The query runs as you, so it
            can only ever show you what you could already open.
          </p>
        </div>
        {compiled.rows.length > 0 && (
          <a
            href={`/api/reports/custom/export?${exportQuery.toString()}`}
            className="label-caps inline-flex items-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 hover:border-[var(--color-accent)]"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
            Export CSV
          </a>
        )}
      </div>

      <ReportFilters
        filters={subject.providerColumn ? ['dateRange', 'location', 'provider'] : ['dateRange', 'location']}
        preset={shell.range.preset}
        from={shell.range.from}
        to={shell.range.to}
        timeZone={shell.ctx.timeZone}
        locations={subject.hasLocation ? shell.locations : []}
        locationId={shell.ctx.locationId}
        providers={shell.providers}
        providerId={shell.ctx.providerId}
        hidden={definitionParams}
      />

      {/* ── The builder ───────────────────────────────── */}
      <form method="get" action="/dashboard/reports/custom" className="mt-8">
        <input type="hidden" name="preset" value={shell.range.preset} />
        {shell.range.preset === 'custom' && (
          <>
            <input type="hidden" name="from" value={shell.range.from} />
            <input type="hidden" name="to" value={shell.range.to} />
          </>
        )}
        {shell.ctx.locationId !== null && (
          <input type="hidden" name="location" value={String(shell.ctx.locationId)} />
        )}
        {shell.ctx.providerId && (
          <input type="hidden" name="provider" value={shell.ctx.providerId} />
        )}

        <div className="grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] lg:grid-cols-3">
          <div className="bg-[var(--color-surface)] p-6">
            <Label htmlFor="subject">Subject</Label>
            <Select id="subject" name="subject" defaultValue={subject.key}>
              {SUBJECTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
            <p className="mt-3 text-xs text-[var(--color-muted)]">{subject.description}</p>
            {subject.excluded && (
              <p className="mt-3 text-xs text-[var(--color-muted)]">{subject.excluded}</p>
            )}
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              Changing the subject resets the columns.
            </p>
          </div>

          <div className="bg-[var(--color-surface)] p-6">
            <span className="label-caps mb-2 block text-[var(--color-muted)]">Columns</span>
            <ul className="space-y-2">
              {subject.columns.map((c) => (
                <li key={c.key}>
                  <label className="flex items-center gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      name="cols"
                      value={c.key}
                      defaultChecked={definition.columns.includes(c.key)}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    {c.label}
                  </label>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-[var(--color-surface)] p-6">
            <Label htmlFor="group">Group by</Label>
            <Select id="group" name="group" defaultValue={definition.groupBy ?? ''}>
              <option value="">No grouping — one row each</option>
              {groupable.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Grouping counts rows and adds up the money columns.
            </p>

            <div className="mt-5 flex gap-3">
              <div className="flex-1">
                <Label htmlFor="sort">Sort by</Label>
                <Select id="sort" name="sort" defaultValue={definition.sort ?? ''}>
                  <option value="">Default</option>
                  {sortable.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-32">
                <Label htmlFor="dir">Order</Label>
                <Select id="dir" name="dir" defaultValue={definition.sortDir}>
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </Select>
              </div>
            </div>

            {subject.filters.length > 0 && (
              <div className="mt-5 space-y-3">
                {subject.filters.map((f) => (
                  <div key={f.key}>
                    <Label htmlFor={`f_${f.key}`}>{f.label}</Label>
                    <Select
                      id={`f_${f.key}`}
                      name={`f_${f.key}`}
                      defaultValue={definition.filters[f.key] ?? ''}
                    >
                      <option value="">Any</option>
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <Button type="submit" variant="subtle" size="sm" className="mt-5">
          Run report
        </Button>
      </form>

      {/* ── Results ───────────────────────────────────── */}
      {error ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm">
          That combination could not be run.
          <span className="mt-2 block text-[var(--color-muted)]">{error}</span>
        </p>
      ) : compiled.rows.length === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          No {subject.label.toLowerCase()} in {shell.range.label}
          {Object.keys(definition.filters).length > 0 ? ' matching those filters' : ''}.
        </p>
      ) : (
        <div className="mt-10">
          {truncated && (
            <p className="mb-4 border border-[var(--color-accent)] bg-[var(--color-surface)] p-4 text-sm">
              More than {ROW_CAP.toLocaleString('en-US')} rows matched. This shows the most recent{' '}
              {ROW_CAP.toLocaleString('en-US')}, so the totals below are partial — narrow the date
              range before reading them as figures.
            </p>
          )}
          <ReportTable
            columns={compiled.columns}
            rows={compiled.rows}
            timeZone={shell.ctx.timeZone}
          />
          <p className="mt-4 text-xs text-[var(--color-muted)]">
            {compiled.rows.length.toLocaleString('en-US')}{' '}
            {compiled.rows.length === 1 ? 'row' : 'rows'} · {shell.range.label}
            {subject.dateNullable &&
              ` · rows with no ${subject.dateColumn.replace(/_/g, ' ')} are not in any window`}
          </p>
        </div>
      )}

      {/* ── Save ──────────────────────────────────────── */}
      <section className="mt-14 border-t border-[var(--color-border)] pt-8">
        <h2 className="label-caps text-[var(--color-accent)]">Saved reports</h2>

        <form action={saveDefinition} className="mt-5 flex flex-wrap items-end gap-3">
          <input type="hidden" name="definition" value={JSON.stringify(definition)} />
          <div className="w-72">
            <Label htmlFor="save-name">Save this setup as</Label>
            <Input
              id="save-name"
              name="name"
              maxLength={120}
              required
              placeholder="Retail by channel"
            />
          </div>
          <label className="mb-3 flex items-center gap-2.5 text-sm">
            <input type="checkbox" name="is_shared" className="h-4 w-4 accent-[var(--color-accent)]" />
            Share with other managers
          </label>
          <Button type="submit" variant="subtle" size="sm" className="mb-0.5">
            Save
          </Button>
        </form>

        {saved.length === 0 ? (
          <p className="mt-6 text-sm text-[var(--color-muted)]">Nothing saved yet.</p>
        ) : (
          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {saved.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <Link
                  href={`/dashboard/reports/custom?load=${s.id}`}
                  className="text-sm hover:text-[var(--color-accent)]"
                >
                  {s.name}
                  <span className="ml-3 text-xs text-[var(--color-muted)]">
                    {findSubject(String(s.definition?.subject ?? ''))?.label ?? 'Unknown subject'}
                    {s.is_shared ? ' · shared' : ''}
                  </span>
                </Link>
                {s.created_by === shell.viewer.id && (
                  <form action={deleteDefinition}>
                    <input type="hidden" name="id" value={s.id} />
                    <button
                      type="submit"
                      className="label-caps text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                    >
                      Delete
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-14 max-w-2xl border-t border-[var(--color-border)] pt-6">
        <h2 className="label-caps text-[var(--color-muted)]">What this builder will not do</h2>
        <ul className="mt-3 space-y-2 text-sm text-[var(--color-muted)]">
          <li>
            It does not run SQL. There is no query box, because this database holds clinical
            records and an arbitrary-read box pointed at them is not a feature.
          </li>
          <li>
            It cannot reach a column that is not on the list above. Notes, intake answers, consent
            text, patch tests and photographs are absent from the builder entirely.
          </li>
          <li>
            No joins beyond the ones offered, no computed expressions, and grouping is worked out
            after fetching at most {ROW_CAP.toLocaleString('en-US')} rows — so a truncated result
            says so rather than quietly totalling a sample.
          </li>
          <li>
            It runs with your own permissions, not elevated ones. If a report comes back thin, it
            is showing you your access, not hiding an error.
          </li>
        </ul>
      </section>
    </div>
  )
}
