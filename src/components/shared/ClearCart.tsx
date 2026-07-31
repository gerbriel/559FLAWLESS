'use client'

import { useEffect } from 'react'
import { useCart } from '@/store/cart'

/** Empties the local bag after a completed checkout. Renders nothing. */
export function ClearCart() {
  const clear = useCart((s) => s.clear)

  useEffect(() => {
    clear()
  }, [clear])

  return null
}
