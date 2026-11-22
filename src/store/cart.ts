'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface CartLine {
  productId: number
  qty: number
}

interface CartState {
  lines: CartLine[]
  /**
   * A promo code waiting to be checked. Typed in the bag or carried in on a
   * marketplace checkout URL; validated by the checkout route against Stripe,
   * never here. The bag shows it, the server decides what it is worth.
   */
  coupon: string | null
  add: (productId: number, qty?: number) => void
  setQty: (productId: number, qty: number) => void
  remove: (productId: number) => void
  setCoupon: (code: string | null) => void
  clear: () => void
  count: () => number
}

/**
 * The cart holds product ids and quantities only — never prices. Totals are
 * recomputed server-side at checkout from the current catalog, so a tampered
 * localStorage cart can't buy a $200 serum for $2.
 */
export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      lines: [],
      coupon: null,

      add: (productId, qty = 1) =>
        set((state) => {
          const existing = state.lines.find((l) => l.productId === productId)
          if (existing) {
            return {
              lines: state.lines.map((l) =>
                l.productId === productId ? { ...l, qty: Math.min(l.qty + qty, 99) } : l
              ),
            }
          }
          return { lines: [...state.lines, { productId, qty: Math.min(qty, 99) }] }
        }),

      // Sets the line to exactly `qty`, adding it if absent. Idempotent, which
      // is what a checkout URL needs: landing on it twice is one bag, not two.
      setQty: (productId, qty) =>
        set((state) => {
          if (qty <= 0) return { lines: state.lines.filter((l) => l.productId !== productId) }
          const bounded = Math.min(qty, 99)
          return state.lines.some((l) => l.productId === productId)
            ? { lines: state.lines.map((l) => (l.productId === productId ? { ...l, qty: bounded } : l)) }
            : { lines: [...state.lines, { productId, qty: bounded }] }
        }),

      remove: (productId) =>
        set((state) => ({ lines: state.lines.filter((l) => l.productId !== productId) })),

      setCoupon: (code) => set({ coupon: code ? code.trim().toUpperCase() || null : null }),

      clear: () => set({ lines: [], coupon: null }),

      count: () => get().lines.reduce((n, l) => n + l.qty, 0),
    }),
    { name: 'fl_cart' }
  )
)
