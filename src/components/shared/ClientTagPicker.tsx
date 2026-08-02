'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'

export interface ClientTagOption {
  id: number
  name: string
  description: string | null
  is_alert: boolean
}

/**
 * The shorthand a studio keeps in its head, written down.
 *
 * Two kinds of tag, and the difference matters: most are a chip ("VIP",
 * "referred a friend"), and some are the thing you must read before you touch
 * somebody's skin. `is_alert` marks the second kind and colours it like the
 * contraindication flags above, because that is what it is.
 */
export function ClientTagPicker({
  clientId,
  assigned,
  all,
}: {
  clientId: string
  assigned: ClientTagOption[]
  all: ClientTagOption[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const assignedIds = new Set(assigned.map((t) => t.id))
  const available = all.filter((t) => !assignedIds.has(t.id))

  async function add(tagId: number) {
    setBusy(true)
    const { error } = await createClient()
      .from('client_tag_links')
      .insert({ client_id: clientId, tag_id: tagId })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not add that tag.')
      return
    }
    setOpen(false)
    router.refresh()
  }

  async function remove(tagId: number) {
    setBusy(true)
    const { error } = await createClient()
      .from('client_tag_links')
      .delete()
      .eq('client_id', clientId)
      .eq('tag_id', tagId)
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not remove that tag.')
      return
    }
    router.refresh()
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {assigned.map((t) => (
        <span key={t.id} className="group inline-flex">
          <Badge tone={t.is_alert ? 'warning' : 'accent'} size="sm" title={t.description ?? undefined}>
            {t.name}
            <button
              type="button"
              onClick={() => remove(t.id)}
              disabled={busy}
              aria-label={`Remove ${t.name}`}
              className="ml-0.5 opacity-50 transition-opacity hover:opacity-100"
            >
              <X className="h-3 w-3" strokeWidth={2} />
            </button>
          </Badge>
        </span>
      ))}

      {available.length > 0 &&
        (open ? (
          <span className="flex flex-wrap gap-1.5">
            {available.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => add(t.id)}
                disabled={busy}
                title={t.description ?? undefined}
                className="label-caps border border-dashed border-[var(--color-border)] px-2 py-0.5 text-[0.625rem] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-foreground)]"
              >
                {t.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="label-caps px-1 text-[0.625rem] text-[var(--color-muted)]"
            >
              Done
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="label-caps inline-flex items-center gap-1 border border-dashed border-[var(--color-border)] px-2 py-0.5 text-[0.625rem] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-foreground)]"
          >
            <Plus className="h-3 w-3" strokeWidth={2} />
            Tag
          </button>
        ))}
    </div>
  )
}
