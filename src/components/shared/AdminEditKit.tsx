'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check, PencilLine, RotateCcw, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

/**
 * Editing the storefront where it stands.
 *
 * An admin browsing the public site gets a small bar pinned to the bottom
 * corner. "Edit page" turns every block whose copy lives in `site_content`
 * into the form for itself: the real heading, at the real size, on the real
 * background, with a caret in it. Changes stage locally, the bar counts them,
 * and one Save writes them all — so half an edit never goes live because
 * somebody was interrupted between two fields.
 *
 * WHY THE ADMIN CHECK IS CLIENT-SIDE. The public layout deliberately never
 * reads the session — its own header comment explains that touching cookies
 * would opt the whole marketing site out of static caching. So this component
 * mounts for everyone, renders nothing until it has quietly confirmed the
 * viewer is an admin, and costs an anonymous visitor one localStorage read.
 * That check is presentation, not protection: the write is guarded by RLS
 * ("admin writes site content", 009), which refuses anyone else no matter
 * what this component was talked into showing.
 *
 * WHAT IS EDITABLE. Server components mark their editable text with two plain
 * attributes — `data-edit-key` on a block naming its `site_content` row, and
 * `data-edit-field` on each text node naming the field inside that row's
 * jsonb. Attributes cost the server pages nothing: no client boundary, no
 * props, no hydration. This kit finds them at the moment editing turns on,
 * which is also what makes the feature additive — a block nobody marked is
 * simply not editable.
 *
 * WHAT IS NOT. Text that lives in JSX rather than the database (section
 * labels, button copy that never changes, legal text with its own versioned
 * editor) has no row to save into, so the kit does not pretend to edit it.
 * Blocks with their own richer editors — announcements, services, products,
 * reviews — keep them; the bar is for the copy that had no screen at all.
 */

type Role = 'unknown' | 'not_admin' | 'admin'

export function AdminEditKit() {
  const router = useRouter()
  const [role, setRole] = React.useState<Role>('unknown')
  const [editing, setEditing] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  /** key → field → staged text. Only fields that differ from their original. */
  const [drafts, setDrafts] = React.useState<Record<string, Record<string, string>>>({})
  const [fieldCount, setFieldCount] = React.useState(0)

  // Who is looking. getSession reads local storage, so an anonymous visitor
  // pays nothing and never hits the network; only a signed-in session costs
  // one profile read.
  React.useEffect(() => {
    let live = true
    const supabase = createClient()
    void supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session?.user) {
        if (live) setRole('not_admin')
        return
      }
      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle()
      if (live) setRole(data?.role === 'admin' ? 'admin' : 'not_admin')
    })
    return () => {
      live = false
    }
  }, [])

  const dirtyCount = Object.values(drafts).reduce((n, f) => n + Object.keys(f).length, 0)
  // Mirrored into a ref for the two DOM listeners (link clicks, beforeunload),
  // which are attached once per edit session and must not re-attach on every
  // keystroke. An effect rather than a render-time write — the Compiler
  // forbids touching refs during render, and it is right to: this value is
  // only ever read from event handlers.
  const dirtyRef = React.useRef(0)
  React.useEffect(() => {
    dirtyRef.current = dirtyCount
  }, [dirtyCount])

  /* ── Turning the page into its own form ─────────────────── */

  React.useEffect(() => {
    if (!editing) return

    const fields = Array.from(
      document.querySelectorAll<HTMLElement>('[data-edit-key] [data-edit-field]')
    )
    // The original text rides on the element itself rather than in React
    // state: the DOM is already the system of record for what is on screen,
    // and keeping a parallel array of element references is exactly the
    // shared mutable structure the Compiler refuses to let handlers touch.
    for (const el of fields) {
      if (el.dataset.editOriginal === undefined) {
        el.dataset.editOriginal = el.textContent ?? ''
      }
    }
    document.documentElement.setAttribute('data-edit-live', '1')

    const onInput = (e: Event) => {
      const el = e.currentTarget as HTMLElement
      const field = el.getAttribute('data-edit-field')
      const key = el.closest('[data-edit-key]')?.getAttribute('data-edit-key')
      if (!field || !key) return
      const original = el.dataset.editOriginal ?? ''
      const text = el.textContent ?? ''
      setDrafts((cur) => {
        const forKey = { ...(cur[key] ?? {}) }
        if (text === original) delete forKey[field]
        else forKey[field] = text
        const next = { ...cur, [key]: forKey }
        if (Object.keys(forKey).length === 0) delete next[key]
        return next
      })
    }

    for (const el of fields) {
      // plaintext-only keeps a paste from smuggling markup into a jsonb field
      // that every visitor's page renders. Firefox only got it in 2024, so the
      // fallback is 'true' plus the fact that we only ever read textContent.
      try {
        el.contentEditable = 'plaintext-only'
      } catch {
        el.contentEditable = 'true'
      }
      el.addEventListener('input', onInput)
    }

    // While a page is a form, a link is a hole in the floor. Every anchor
    // click is stopped — not confirmed, stopped — so putting a caret in the
    // hero's CTA button does not navigate, and a half-finished edit cannot be
    // walked away from by muscle memory. Done is the way out.
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a[href]')
      if (!anchor) return
      e.preventDefault()
      e.stopPropagation()
      if (dirtyRef.current > 0) {
        toast.error('Save or discard your edits first — then the page navigates normally.')
      } else {
        toast('Press Done to stop editing first.')
      }
    }
    document.addEventListener('click', onClick, true)

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current > 0) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)

    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.documentElement.removeAttribute('data-edit-live')
      for (const el of fields) {
        el.removeAttribute('contenteditable')
        delete el.dataset.editOriginal
        el.removeEventListener('input', onInput)
      }
    }
  }, [editing])

  /* ── The three verbs ────────────────────────────────────── */

  function discard() {
    for (const el of document.querySelectorAll<HTMLElement>('[data-edit-key] [data-edit-field]')) {
      const original = el.dataset.editOriginal
      if (original !== undefined && (el.textContent ?? '') !== original) {
        el.textContent = original
      }
    }
    setDrafts({})
  }

  async function saveAll() {
    setBusy(true)
    const supabase = createClient()

    try {
      for (const [key, fields] of Object.entries(drafts)) {
        // Read-merge-write, so the two fields edited here do not wipe the five
        // that were not. The read is the public one; the write is what RLS
        // actually guards.
        const { data: row, error: readError } = await supabase
          .from('site_content')
          .select('value')
          .eq('key', key)
          .maybeSingle()
        if (readError) throw new Error(readError.message)

        const merged: Record<string, string | null> = {
          ...((row?.value as Record<string, string | null>) ?? {}),
        }
        for (const [field, text] of Object.entries(fields)) {
          // Emptied on purpose reads as "back to the built-in default": the
          // pages render `value.field ?? fallback`, and an empty string would
          // sail past ?? and publish a blank heading.
          merged[field] = text.trim() === '' ? null : text
        }

        const { error } = await supabase.from('site_content').upsert({ key, value: merged })
        if (error) throw new Error(error.message)
      }

      toast.success(
        dirtyCount === 1 ? 'Saved. It is live now.' : `All ${dirtyCount} changes saved. They are live now.`
      )
      setDrafts({})
      setEditing(false)
      // The page under us is statically cached for five minutes; the refresh
      // re-renders it with what was just written rather than waiting them out.
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save. Nothing was lost — try again.')
    } finally {
      setBusy(false)
    }
  }

  function done() {
    if (dirtyCount > 0) {
      if (!confirm(`Throw away ${dirtyCount} unsaved ${dirtyCount === 1 ? 'change' : 'changes'}?`)) {
        return
      }
      discard()
    }
    setEditing(false)
  }

  /* ── The bar ────────────────────────────────────────────── */

  if (role !== 'admin') return null

  if (!editing) {
    return (
      <div className="fixed bottom-4 right-4 z-50 print:hidden">
        <button
          type="button"
          onClick={() => {
            // Counted here, in the handler, rather than in the effect that
            // wires the fields up — the bar's message needs the number, and
            // the Compiler (rightly) refuses a setState inside an effect.
            setFieldCount(
              document.querySelectorAll('[data-edit-key] [data-edit-field]').length
            )
            setEditing(true)
          }}
          className="label-caps flex min-h-11 items-center gap-2 border border-[var(--color-foreground)] bg-[var(--color-foreground)] px-4 text-[var(--color-background)] shadow-lg transition-colors hover:bg-[var(--color-clay-deep)] hover:border-[var(--color-clay-deep)]"
        >
          <PencilLine className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          Edit page
        </button>
      </div>
    )
  }

  return (
    <div
      role="toolbar"
      aria-label="Page editing"
      className="fixed bottom-4 right-4 z-50 flex flex-wrap items-center gap-2 border border-[var(--color-foreground)] bg-[var(--color-surface)] p-2 pl-4 shadow-xl print:hidden"
    >
      <span className="text-sm tabular-nums">
        {fieldCount === 0
          ? 'Nothing on this page is editable yet'
          : dirtyCount === 0
            ? 'Click any outlined text'
            : `${dirtyCount} unsaved ${dirtyCount === 1 ? 'change' : 'changes'}`}
      </span>

      <span className="ml-2 flex items-center gap-2">
        <button
          type="button"
          onClick={discard}
          disabled={busy || dirtyCount === 0}
          className="label-caps flex min-h-11 items-center gap-1.5 border border-[var(--color-border)] px-3 transition-colors hover:border-[var(--color-accent)] disabled:opacity-40"
        >
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          Discard
        </button>

        <button
          type="button"
          onClick={() => void saveAll()}
          disabled={busy || dirtyCount === 0}
          className={cn(
            'label-caps flex min-h-11 items-center gap-1.5 border px-3 transition-colors disabled:opacity-40',
            'border-[var(--color-foreground)] bg-[var(--color-foreground)] text-[var(--color-background)] hover:bg-[var(--color-clay-deep)] hover:border-[var(--color-clay-deep)]'
          )}
        >
          <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          {busy ? 'Saving…' : 'Save all'}
        </button>

        <button
          type="button"
          onClick={done}
          disabled={busy}
          className="flex h-11 w-11 items-center justify-center text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)]"
          aria-label="Stop editing"
        >
          <X className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </span>
    </div>
  )
}
