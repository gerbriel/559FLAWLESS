'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Select } from '@/components/ui/field'
import type { OrderStatus, FulfillmentMethod } from '@/types/database'

/**
 * Advance an order through fulfilment.
 *
 * Until this existed nothing in the app could move an order past `paid`, so the
 * queue only ever grew and "Completed" was permanently empty. The options differ by
 * fulfilment because "ready for pickup" is meaningless for something being
 * posted, and "shipped" is meaningless for something collected at the door.
 */
export function OrderStatusControl({
  orderId,
  status,
  fulfillment,
}: {
  orderId: number
  status: OrderStatus
  fulfillment: FulfillmentMethod
}) {
  const router = useRouter()
  const [value, setValue] = useState(status)
  const [busy, setBusy] = useState(false)

  const options: { value: OrderStatus; label: string }[] =
    fulfillment === 'pickup'
      ? [
          { value: 'paid', label: 'Paid' },
          { value: 'fulfilling', label: 'Getting it ready' },
          { value: 'ready_for_pickup', label: 'Ready for pickup' },
          { value: 'completed', label: 'Collected' },
          { value: 'cancelled', label: 'Cancelled' },
        ]
      : [
          { value: 'paid', label: 'Paid' },
          { value: 'fulfilling', label: 'Packing' },
          { value: 'shipped', label: 'Shipped' },
          { value: 'completed', label: 'Delivered' },
          { value: 'cancelled', label: 'Cancelled' },
        ]

  async function change(next: OrderStatus) {
    const previous = value
    setValue(next)
    setBusy(true)

    const { error } = await createClient()
      .from('orders')
      .update({ status: next })
      .eq('id', orderId)

    setBusy(false)

    if (error) {
      setValue(previous)
      toast.error('Could not update that order.')
      return
    }

    toast.success('Updated.')
    router.refresh()
  }

  return (
    <Select
      value={value}
      onChange={(e) => change(e.target.value as OrderStatus)}
      disabled={busy}
      aria-label="Order status"
      className="w-48"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  )
}
