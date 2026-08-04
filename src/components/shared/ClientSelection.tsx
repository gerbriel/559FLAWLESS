'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check, Copy, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/field'

/**
 * Selecting rows, and doing one thing to all of them.
 *
 * The table this wraps is a Server Component and stays one — the provider takes
 * server-rendered rows as `children` and only the checkboxes and the bar are
 * client code. That keeps the roster's queries, its badges and its links on the
 * server, where they were.
 *
 * Selection is per page and says so. The alternative — "select all 340 that
 * match this search" — means the action travels as a filter rather than a list
 * of ids, and every action here would have to be re-expressed as a query the
 * server re-runs. That is a different and much sharper tool: the count you
 * confirm is not a list you looked at. A page of twenty-five you can see is the
 * right first version of a feature whose sixth action is irreversible.
 */

type Id = string | number

interface SelectionState {
  selected: Set<Id>
  toggle: (id: Id) => void
  setMany: (ids: Id[], on: boolean) => void
  clear: () => void
  pageIds: Id[]
}

const Ctx = React.createContext<SelectionState | null>(null)

function useSelection(): SelectionState {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error('Selection components must sit inside <SelectionProvider>')
  return ctx
}

export function SelectionProvider({
  pageIds,
  children,
}: {
  pageIds: Id[]
  children: React.ReactNode
}) {
  const [selected, setSelected] = React.useState<Set<Id>>(new Set())

  // Paging or searching replaces the rows under the selection. Keeping ids that
  // are no longer on screen would mean a bar reading "12 selected" above four
  // visible ticks, and a delete that reached eight people the person never saw.
  const key = pageIds.join(',')
  const [seenKey, setSeenKey] = React.useState(key)
  if (key !== seenKey) {
    setSeenKey(key)
    if (selected.size > 0) setSelected(new Set())
  }

  const value = React.useMemo<SelectionState>(
    () => ({
      selected,
      pageIds,
      toggle: (id) =>
        setSelected((cur) => {
          const next = new Set(cur)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        }),
      setMany: (ids, on) =>
        setSelected((cur) => {
          const next = new Set(cur)
          for (const id of ids) {
            if (on) next.add(id)
            else next.delete(id)
          }
          return next
        }),
      clear: () => setSelected(new Set()),
    }),
    [selected, pageIds]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

const BOX =
  'h-4 w-4 shrink-0 accent-[var(--color-accent)] cursor-pointer disabled:cursor-default'

/** The tick in one row. */
export function SelectRow({ id, label }: { id: Id; label: string }) {
  const { selected, toggle } = useSelection()
  return (
    <input
      type="checkbox"
      className={BOX}
      checked={selected.has(id)}
      onChange={() => toggle(id)}
      aria-label={`Select ${label}`}
    />
  )
}

/** The tick in the header: this page, on or off. */
export function SelectAll() {
  const { selected, pageIds, setMany } = useSelection()
  const ref = React.useRef<HTMLInputElement>(null)
  const onPage = pageIds.filter((id) => selected.has(id)).length
  const all = pageIds.length > 0 && onPage === pageIds.length

  // Indeterminate is a property, not an attribute — React cannot set it in JSX.
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = onPage > 0 && !all
  }, [onPage, all])

  return (
    <input
      ref={ref}
      type="checkbox"
      className={BOX}
      checked={all}
      onChange={() => setMany(pageIds, !all)}
      aria-label={all ? 'Clear this page' : 'Select everyone on this page'}
    />
  )
}

export interface ClientTagOption {
  id: number
  name: string
}

type Pending =
  | { kind: 'delete' }
  | { kind: 'archive' }
  | { kind: 'invite' }
  | null

/**
 * The bar that appears once something is ticked.
 *
 * `target` decides which actions exist, and the split is not cosmetic: everyone
 * on the roster already has an account, so there is nobody there to invite —
 * and a contact has no profile, so there is nothing there to tag, opt out of
 * marketing, or archive.
 */
export function BulkActionBar({
  target,
  tags,
  canAdmin,
}: {
  target: 'client' | 'stub'
  tags?: ClientTagOption[]
  canAdmin: boolean
}) {
  const { selected, clear } = useSelection()
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [pending, setPending] = React.useState<Pending>(null)
  const [tagId, setTagId] = React.useState('')
  const [links, setLinks] = React.useState<{ name: string; email: string; url: string }[]>([])

  const ids = React.useMemo(() => [...selected], [selected])
  const count = ids.length
  if (count === 0) return null

  const noun = target === 'stub' ? (count === 1 ? 'contact' : 'contacts') : count === 1 ? 'client' : 'clients'

  async function run(body: Record<string, unknown>, done?: (data: Record<string, unknown>) => void) {
    setBusy(true)
    try {
      const res = await fetch('/api/clients/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          target === 'stub' ? { stubIds: ids, ...body } : { clientIds: ids, ...body }
        ),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.message ?? 'That did not go through.')
        return
      }
      if (done) done(data)
      else {
        toast.success(`${data.affected} ${noun} updated.`)
        clear()
      }
      router.refresh()
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  function exportSelected() {
    // A GET, so the browser handles it as a download rather than this component
    // holding a CSV in memory. Same endpoint and same columns as the full
    // export — one definition of what a client row looks like.
    const query = new URLSearchParams({ ids: ids.join(',') })
    window.location.href = `/api/data/export/${target === 'stub' ? 'clients' : 'clients'}?${query}`
  }

  return (
    <>
      {/* Sticks to the bottom so it is reachable however far down you scrolled
          to make the selection. */}
      <div className="sticky bottom-4 z-20 mt-4">
        <div
          data-ui="panel"
          className="flex flex-wrap items-center gap-3 border border-[var(--color-foreground)] bg-[var(--color-surface)] p-3 shadow-lg"
        >
          <span className="pl-1.5 text-sm tabular-nums">
            {count} {noun} selected
          </span>

          <span className="ml-auto flex flex-wrap items-center gap-2">
            {target === 'stub' && (
              <Button size="sm" variant="subtle" disabled={busy} onClick={() => setPending({ kind: 'invite' })}>
                Invite
              </Button>
            )}

            {target === 'client' && tags && tags.length > 0 && (
              <span className="flex items-center gap-2">
                <Select
                  aria-label="Tag to apply"
                  className="min-h-9 w-40 py-1 text-sm"
                  value={tagId}
                  onChange={(e) => setTagId(e.target.value)}
                >
                  <option value="">Add a tag…</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={busy || !tagId}
                  onClick={() => run({ action: 'tag', tagId: Number(tagId) })}
                >
                  Tag
                </Button>
              </span>
            )}

            <Button size="sm" variant="subtle" disabled={busy} onClick={exportSelected}>
              Export
            </Button>

            {target === 'client' && (
              <Button
                size="sm"
                variant="subtle"
                disabled={busy}
                onClick={() => run({ action: 'marketing_opt_out' })}
              >
                Opt out of marketing
              </Button>
            )}

            {target === 'client' && canAdmin && (
              <Button size="sm" variant="subtle" disabled={busy} onClick={() => setPending({ kind: 'archive' })}>
                Archive
              </Button>
            )}

            {target === 'client' && canAdmin && (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => setPending({ kind: 'delete' })}>
                Delete
              </Button>
            )}

            <button
              type="button"
              onClick={clear}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              aria-label="Clear selection"
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </span>
        </div>
      </div>

      {pending && (
        <Confirm
          pending={pending}
          count={count}
          noun={noun}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={(confirmText) => {
            if (pending.kind === 'delete') {
              void run({ action: 'delete', confirm: confirmText })
            } else if (pending.kind === 'archive') {
              void run({ action: 'archive' })
            } else {
              void run({ action: 'invite' }, (data) => {
                const made = (data.links ?? []) as typeof links
                setLinks(made)
                const skipped = Number(data.skipped ?? 0)
                toast.success(
                  `${made.length} ${made.length === 1 ? 'invitation' : 'invitations'} created${
                    skipped > 0 ? `, ${skipped} skipped` : ''
                  }.`
                )
                clear()
              })
            }
          }}
        />
      )}

      {links.length > 0 && <LinkSheet links={links} onClose={() => setLinks([])} />}
    </>
  )
}

/**
 * The stop before something that cannot be undone.
 *
 * Delete asks for the word to be typed. That is not ceremony: `anonymise_account`
 * takes a person's name, email, phone and every photograph of them, and keeps
 * the consent signatures and the tax records pointing at a row nobody can
 * identify any more. There is no undo to offer afterwards, so the friction has
 * to be in front.
 */
function Confirm({
  pending,
  count,
  noun,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: NonNullable<Pending>
  count: number
  noun: string
  busy: boolean
  onCancel: () => void
  onConfirm: (confirmText: string) => void
}) {
  const [typed, setTyped] = React.useState('')
  const isDelete = pending.kind === 'delete'

  const copy = {
    delete: {
      title: `Delete ${count} ${noun}?`,
      body: 'This removes their name, email, phone number, date of birth and every photograph of them, and it cannot be undone. Their signed consent forms, treatment notes and sales records are kept — the law requires it — but nothing left will identify who they were.',
    },
    archive: {
      title: `Archive ${count} ${noun}?`,
      body: 'They stop appearing in the client list and cannot sign in. Nothing is deleted, and you can restore them at any time.',
    },
    invite: {
      title: `Invite ${count} ${noun}?`,
      body: 'Each one gets a fresh link that claims their account and lets them fill in their own details. Anyone without an email address, or who has already signed up, is skipped. Nothing is emailed — you will get the links to send.',
    },
  }[pending.kind]

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <button
        type="button"
        aria-label="Cancel"
        tabIndex={-1}
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-black/50"
      />
      <div
        role="dialog"
        aria-modal="true"
        data-ui="panel"
        className="relative w-full max-w-md border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
      >
        <h2 className="display text-2xl">{copy.title}</h2>
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">{copy.body}</p>

        {isDelete && (
          <label className="mt-5 block">
            <span className="label-caps block text-[var(--color-muted)]">
              Type DELETE to confirm
            </span>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              data-ui="input"
              className="mt-2 min-h-11 w-full border border-[var(--color-border)] bg-[var(--color-background)] px-3 text-base outline-none focus:border-[var(--color-accent)] sm:text-sm"
            />
          </label>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2.5">
          <Button size="sm" variant="subtle" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={isDelete ? 'danger' : 'primary'}
            disabled={busy || (isDelete && typed !== 'DELETE')}
            onClick={() => onConfirm(typed)}
          >
            {busy ? 'Working…' : isDelete ? 'Delete them' : 'Yes, go ahead'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The links, once they exist.
 *
 * There is no transactional email provider wired up, so a bulk invite hands
 * back what the single invite hands back — a link per person — and the studio
 * sends them. Shown once, because only the hash reaches the database.
 */
function LinkSheet({
  links,
  onClose,
}: {
  links: { name: string; email: string; url: string }[]
  onClose: () => void
}) {
  const [copied, setCopied] = React.useState<string | null>(null)

  const asText = links.map((l) => `${l.name} <${l.email}>\n${l.url}`).join('\n\n')

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/50"
      />
      <div
        role="dialog"
        aria-modal="true"
        data-ui="panel"
        className="relative flex max-h-[80vh] w-full max-w-lg flex-col border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
      >
        <h2 className="display text-2xl">{links.length} invitations</h2>
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
          Send each person their own link. They are shown once — only a hash of each is
          stored, so closing this cannot be undone, though you can always issue a fresh
          invitation.
        </p>

        <ul className="mt-5 min-h-0 flex-1 space-y-3 overflow-y-auto">
          {links.map((l) => (
            <li key={l.url} className="border-b border-[var(--color-border)] pb-3 text-sm">
              <p>{l.name}</p>
              <p className="text-xs text-[var(--color-muted)]">{l.email}</p>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]">
                  {l.url}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(l.url)
                    setCopied(l.url)
                  }}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)]"
                  aria-label={`Copy the link for ${l.name}`}
                >
                  {copied === l.url ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2} />
                  ) : (
                    <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
                  )}
                </button>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex flex-wrap justify-end gap-2.5">
          <Button
            size="sm"
            variant="subtle"
            onClick={() => {
              void navigator.clipboard.writeText(asText)
              toast.success('All of them copied.')
            }}
          >
            Copy all
          </Button>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}
