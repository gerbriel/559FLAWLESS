'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/field'

interface ChangeRequest {
  id: number
  summary: string
  reason: string | null
  status: 'pending' | 'approved' | 'rejected'
  target_table: string | null
  target_id: number | null
  old_value: number | null
  new_value: number | null
  created_at: string
  review_note: string | null
}

export function ApprovalRow({
  request,
  requestedBy,
}: {
  request: ChangeRequest
  requestedBy: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  /**
   * Approving applies the change with the reviewer's own client — the same
   * pattern as united-metal-components. There is no dynamic SQL and no service
   * role: RLS still decides whether this manager may write the target table.
   */
  async function decide(approve: boolean) {
    setBusy(true)
    const supabase = createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      setBusy(false)
      toast.error('Please sign in again.')
      return
    }

    if (approve && request.target_table === 'products' && request.target_id != null) {
      const delta = (request.new_value ?? 0) - (request.old_value ?? 0)

      // adjust_stock writes the balance and the log row together.
      const { error: applyError } = await supabase.rpc('adjust_stock', {
        p_product_id: request.target_id,
        p_change: delta,
        p_reason: 'adjustment',
        p_note: `Approved request #${request.id}`,
      })

      if (applyError) {
        setBusy(false)
        toast.error('Could not apply the change. Nothing was altered.')
        return
      }
    }

    const { error } = await supabase
      .from('inventory_change_requests')
      .update({
        status: approve ? 'approved' : 'rejected',
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        review_note: note.trim() || null,
      })
      .eq('id', request.id)

    setBusy(false)

    if (error) {
      toast.error('Could not record the decision.')
      return
    }

    toast.success(approve ? 'Approved and applied.' : 'Rejected.')
    router.refresh()
  }

  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p>{request.summary}</p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {requestedBy} ·{' '}
            {new Date(request.created_at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </p>
          {request.reason && (
            <p className="mt-2 text-sm text-[var(--color-muted)]">“{request.reason}”</p>
          )}
        </div>

        <Badge
          tone={
            request.status === 'approved'
              ? 'success'
              : request.status === 'rejected'
                ? 'danger'
                : 'warning'
          }
        >
          {request.status}
        </Badge>
      </div>

      {request.status === 'pending' ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="Note (optional)"
            aria-label="Review note"
            className="max-w-xs flex-1"
          />
          <Button size="sm" onClick={() => decide(true)} disabled={busy}>
            Approve
          </Button>
          <Button size="sm" variant="subtle" onClick={() => decide(false)} disabled={busy}>
            Reject
          </Button>
        </div>
      ) : (
        request.review_note && (
          <p className="mt-4 border-t border-[var(--color-border)] pt-4 text-sm text-[var(--color-muted)]">
            {request.review_note}
          </p>
        )
      )}
    </div>
  )
}
