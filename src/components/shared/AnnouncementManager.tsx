'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Pencil, Trash2, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Textarea, Select } from '@/components/ui/field'
import type { Announcement } from '@/types/database'

type Variant = Announcement['variant']

interface Draft {
  title: string
  body: string
  link_url: string
  link_label: string
  variant: Variant
  is_active: boolean
  starts_at: string
  ends_at: string
}

const EMPTY: Draft = {
  title: '',
  body: '',
  link_url: '',
  link_label: '',
  variant: 'info',
  is_active: true,
  starts_at: '',
  ends_at: '',
}

/** timestamptz ISO → value a <input type="datetime-local"> accepts (local time). */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`
}

/** datetime-local value → ISO string, or null when left blank. */
function fromLocalInput(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function draftFrom(a: Announcement): Draft {
  return {
    title: a.title,
    body: a.body ?? '',
    link_url: a.link_url ?? '',
    link_label: a.link_label ?? '',
    variant: a.variant,
    is_active: a.is_active,
    starts_at: toLocalInput(a.starts_at),
    ends_at: toLocalInput(a.ends_at),
  }
}

export function AnnouncementManager({ announcements }: { announcements: Announcement[] }) {
  const router = useRouter()
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState(false)

  const isEditing = editingId !== null

  function reset() {
    setEditingId(null)
    setDraft(EMPTY)
  }

  function startEdit(a: Announcement) {
    setEditingId(a.id)
    setDraft(draftFrom(a))
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.title.trim()) {
      toast.error('A title is required.')
      return
    }

    setBusy(true)
    const supabase = createClient()

    const payload = {
      title: draft.title.trim(),
      body: draft.body.trim() || null,
      link_url: draft.link_url.trim() || null,
      link_label: draft.link_label.trim() || null,
      variant: draft.variant,
      is_active: draft.is_active,
      starts_at: fromLocalInput(draft.starts_at),
      ends_at: fromLocalInput(draft.ends_at),
    }

    const { error } = isEditing
      ? await supabase.from('announcements').update(payload).eq('id', editingId!)
      : await supabase.from('announcements').insert(payload)

    setBusy(false)

    if (error) {
      toast.error('Could not save that.')
      return
    }

    toast.success(isEditing ? 'Announcement updated.' : 'Announcement created.')
    reset()
    router.refresh()
  }

  async function toggleActive(a: Announcement) {
    const supabase = createClient()
    const { error } = await supabase
      .from('announcements')
      .update({ is_active: !a.is_active })
      .eq('id', a.id)

    if (error) {
      toast.error('Could not update that.')
      return
    }
    toast.success(a.is_active ? 'Turned off.' : 'Now live.')
    router.refresh()
  }

  async function remove(a: Announcement) {
    if (!window.confirm(`Delete “${a.title}”? This cannot be undone.`)) return
    const supabase = createClient()
    const { error } = await supabase.from('announcements').delete().eq('id', a.id)

    if (error) {
      toast.error('Could not delete that.')
      return
    }
    if (editingId === a.id) reset()
    toast.success('Deleted.')
    router.refresh()
  }

  return (
    <div>
      {/* ── Create / edit form ─────────────────────── */}
      <form
        onSubmit={save}
        className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
      >
        <div className="flex items-center justify-between">
          <h3 className="label-caps text-[var(--color-muted)]">
            {isEditing ? 'Edit announcement' : 'New announcement'}
          </h3>
          {isEditing && (
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
          )}
        </div>

        <div className="mt-4 space-y-4">
          <Field label="Title" htmlFor="an_title">
            <Input
              id="an_title"
              required
              maxLength={160}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>

          <Field label="Body" htmlFor="an_body" hint="Optional supporting line.">
            <Textarea
              id="an_body"
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Link URL" htmlFor="an_link" hint="e.g. /shop or a full URL.">
              <Input
                id="an_link"
                value={draft.link_url}
                onChange={(e) => setDraft({ ...draft, link_url: e.target.value })}
              />
            </Field>
            <Field label="Link label" htmlFor="an_label">
              <Input
                id="an_label"
                maxLength={40}
                value={draft.link_label}
                onChange={(e) => setDraft({ ...draft, link_label: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Style" htmlFor="an_variant">
              <Select
                id="an_variant"
                value={draft.variant}
                onChange={(e) =>
                  setDraft({ ...draft, variant: e.target.value as Variant })
                }
              >
                <option value="info">Info (dark)</option>
                <option value="promo">Promo (accent)</option>
                <option value="urgent">Urgent (red)</option>
              </Select>
            </Field>
            <div className="flex items-end">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.is_active}
                  onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                Live on the site
              </label>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts" htmlFor="an_start" hint="Optional. Blank = immediately.">
              <Input
                id="an_start"
                type="datetime-local"
                value={draft.starts_at}
                onChange={(e) => setDraft({ ...draft, starts_at: e.target.value })}
              />
            </Field>
            <Field label="Ends" htmlFor="an_end" hint="Optional. Blank = no end.">
              <Input
                id="an_end"
                type="datetime-local"
                value={draft.ends_at}
                onChange={(e) => setDraft({ ...draft, ends_at: e.target.value })}
              />
            </Field>
          </div>
        </div>

        <div className="mt-5 flex gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : isEditing ? 'Save changes' : 'Create announcement'}
          </Button>
        </div>
      </form>

      {/* ── Existing announcements ─────────────────── */}
      {announcements.length === 0 ? (
        <p className="mt-6 text-sm text-[var(--color-muted)]">None created yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {announcements.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-4 py-4">
              <div className="min-w-0">
                <p className="truncate text-sm">{a.title}</p>
                {a.body && (
                  <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">{a.body}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone="neutral">{a.variant}</Badge>
                <button
                  type="button"
                  onClick={() => toggleActive(a)}
                  title={a.is_active ? 'Turn off' : 'Turn on'}
                >
                  <Badge tone={a.is_active ? 'success' : 'neutral'}>
                    {a.is_active ? 'Live' : 'Off'}
                  </Badge>
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(a)}
                  className="p-1.5 text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                  aria-label={`Edit ${a.title}`}
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => remove(a)}
                  className="p-1.5 text-[var(--color-muted)] hover:text-red-700 dark:hover:text-red-400"
                  aria-label={`Delete ${a.title}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
