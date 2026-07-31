'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'
import type { StockReason } from '@/types/database'

const REASONS: { value: StockReason; label: string }[] = [
  { value: 'received', label: 'Received' },
  { value: 'count_correction', label: 'Count correction' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'expired', label: 'Expired' },
  { value: 'returned', label: 'Returned' },
  { value: 'adjustment', label: 'Other adjustment' },
]

/**
 * Managers write stock through the `adjust_stock` RPC, which moves the balance
 * and writes the log row in one statement so the two can never drift. Everyone
 * else files a change request for a manager to apply.
 */
export function StockAdjuster({
  productId,
  productName,
  currentQty,
  unit,
  canWriteDirectly,
}: {
  productId: number
  productName: string
  currentQty: number
  unit: string
  canWriteDirectly: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [change, setChange] = useState('')
  const [reason, setReason] = useState<StockReason>('received')
  const [note, setNote] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()

    const delta = Number(change)
    if (!Number.isFinite(delta) || delta === 0) {
      toast.error('Enter a non-zero amount.')
      return
    }

    setBusy(true)
    const supabase = createClient()

    if (canWriteDirectly) {
      const { error } = await supabase.rpc('adjust_stock', {
        p_product_id: productId,
        p_change: delta,
        p_reason: reason,
        p_note: note.trim() || null,
      })

      setBusy(false)

      if (error) {
        toast.error('Could not adjust stock.')
        return
      }
      toast.success(`${productName} is now ${currentQty + delta} ${unit}.`)
    } else {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setBusy(false)
        toast.error('Please sign in again.')
        return
      }

      const { error } = await supabase.from('inventory_change_requests').insert({
        entry_type: 'stock_qty',
        target_table: 'products',
        operation: 'update',
        target_id: productId,
        old_value: currentQty,
        new_value: currentQty + delta,
        summary: `${productName}: ${currentQty} → ${currentQty + delta} ${unit} (${reason.replace('_', ' ')})`,
        reason: note.trim() || null,
        requested_by: user.id,
      })

      setBusy(false)

      if (error) {
        toast.error('Could not file that request.')
        return
      }
      toast.success('Sent to a manager for approval.')
    }

    setChange('')
    setNote('')
    setOpen(false)
    router.refresh()
  }

  if (!open) {
    return (
      <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
        Adjust
      </Button>
    )
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left"
    >
      <Field
        label="Change"
        htmlFor={`change_${productId}`}
        hint={`Use a negative number to remove. Now: ${currentQty} ${unit}.`}
      >
        <Input
          id={`change_${productId}`}
          type="number"
          step="any"
          required
          value={change}
          onChange={(e) => setChange(e.target.value)}
          placeholder="+6"
        />
      </Field>

      <Field label="Reason" htmlFor={`reason_${productId}`}>
        <Select
          id={`reason_${productId}`}
          value={reason}
          onChange={(e) => setReason(e.target.value as StockReason)}
        >
          {REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Note" htmlFor={`note_${productId}`}>
        <Input
          id={`note_${productId}`}
          maxLength={200}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : canWriteDirectly ? 'Apply' : 'Request'}
        </Button>
        <Button type="button" size="sm" variant="subtle" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
