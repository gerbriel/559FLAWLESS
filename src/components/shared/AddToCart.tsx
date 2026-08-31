'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCart } from '@/store/cart'
import { trackCartEvent } from './ClientAnalytics'
import { trackMetaEvent } from './MetaPixelEvent'

export function AddToCart({
  productId,
  priceCents,
  disabled,
}: {
  productId: number
  /** For the ad pixel's `value` only — checkout re-prices from the database. */
  priceCents?: number
  disabled?: boolean
}) {
  const [qty, setQty] = useState(1)
  const add = useCart((s) => s.add)

  if (disabled) {
    return (
      <Button disabled size="lg" className="w-full sm:w-auto">
        Out of stock
      </Button>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center border border-[var(--color-border)]">
        <button
          type="button"
          onClick={() => setQty((q) => Math.max(1, q - 1))}
          className="px-3 py-3 transition-colors hover:text-[var(--color-accent)]"
          aria-label="Decrease quantity"
        >
          <Minus className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
        <span className="w-8 text-center text-sm tabular-nums" aria-live="polite">
          {qty}
        </span>
        <button
          type="button"
          onClick={() => setQty((q) => Math.min(99, q + 1))}
          className="px-3 py-3 transition-colors hover:text-[var(--color-accent)]"
          aria-label="Increase quantity"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      <Button
        size="lg"
        onClick={() => {
          void trackCartEvent('add', { product_id: productId, quantity: qty })
          trackMetaEvent('AddToCart', {
            content_ids: [String(productId)],
            content_type: 'product',
            contents: [{ id: String(productId), quantity: qty }],
            ...(priceCents !== undefined
              ? { value: (priceCents * qty) / 100, currency: 'USD' }
              : {}),
          })
          add(productId, qty)
          toast.success('Added to your bag.')
        }}
      >
        Add to bag
      </Button>
    </div>
  )
}
