'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface CartLine {
  productId: number
  qty: number
}

interface CartState {
  lines: CartLine[]
  add: (productId: number, qty?: number) => void
  setQty: (productId: number, qty: number) => void
  remove: (productId: number) => void
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

      setQty: (productId, qty) =>
        set((state) => ({
          lines:
            qty <= 0
              ? state.lines.filter((l) => l.productId !== productId)
              : state.lines.map((l) =>
                  l.productId === productId ? { ...l, qty: Math.min(qty, 99) } : l
                ),
        })),

      remove: (productId) =>
        set((state) => ({ lines: state.lines.filter((l) => l.productId !== productId) })),

      clear: () => set({ lines: [] }),

      count: () => get().lines.reduce((n, l) => n + l.qty, 0),
    }),
    { name: 'fl_cart' }
  )
)
