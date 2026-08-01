'use client'

import { useEffect } from 'react'
import { useCart } from '@/store/cart'
import { trackCartEvent } from './ClientAnalytics'

/** Empties the local bag after a completed checkout. Renders nothing. */
export function ClearCart() {
  const clear = useCart((s) => s.clear)

  useEffect(() => {
    clear()
    void trackCartEvent('clear', { reason: 'checkout_complete' })
  }, [clear])

  return null
}
