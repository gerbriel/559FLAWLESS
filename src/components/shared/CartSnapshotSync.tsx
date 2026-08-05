'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCart, type CartLine } from '@/store/cart'
import { getAnalyticsConsent, sessionId } from '@/components/shared/ClientAnalytics'

const DEBOUNCE_MS = 2000

/**
 * Mirrors the localStorage cart into the server-side snapshot store
 * (upsert_cart_snapshot, migration 060) so staff can see what's in a
 * visitor's bag — bag contents only, never a browsing trail.
 *
 * Mounted once in the public layout. It renders null and owns no state at
 * all: the zustand subscription lives in a plain effect, outside React, and
 * nothing here ever re-renders. No state means nothing to set, which is the
 * whole trick for staying inside the React Compiler rules.
 *
 * Both ends fail soft. The definer function swallows its own errors, and
 * every path here is wrapped too — tracking must never break shopping.
 */
export function CartSnapshotSync() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    async function send(lines: CartLine[]) {
      try {
        // Same consent key, same semantics as every tracker: opted out means
        // no writes of any kind.
        if (!getAnalyticsConsent()) return
        const sid = sessionId()
        if (!sid) return

        const supabase = createClient()
        // Migration 060's definer function may not be in the hand-maintained
        // Database Functions map yet, so the call goes through a locally typed
        // seam that keeps compiling whether or not the generated types have
        // caught up. The server re-validates the payload regardless.
        const rpc = supabase.rpc.bind(supabase) as unknown as (
          fn: 'upsert_cart_snapshot',
          args: { p_session: string; p_lines: CartLine[] }
        ) => PromiseLike<{ error: unknown }>
        await rpc('upsert_cart_snapshot', { p_session: sid, p_lines: lines })
      } catch {
        // Never let a snapshot failure surface anywhere near the shop.
      }
    }

    function schedule(lines: CartLine[]) {
      clearTimeout(timer)
      timer = setTimeout(() => void send(lines), DEBOUNCE_MS)
    }

    // Seed the debounce with whatever the persisted bag already holds, so a
    // returning visitor is snapshotted without having to touch the cart. An
    // empty bag on mount is deliberately not sent — that would write a row
    // for every visitor who never shops. Emptying is different: the
    // subscription below sees the transition to [] and reports it.
    const initial = useCart.getState().lines
    if (initial.length > 0) schedule(initial)

    const unsubscribe = useCart.subscribe((state, prev) => {
      if (state.lines === prev.lines) return
      schedule(state.lines)
    })

    // A snapshot still sitting in the debounce when the tab closes is lost,
    // and that's accepted: navigator.sendBeacon cannot carry a Supabase RPC
    // (it posts an opaque body with no auth headers), and a pagehide fetch
    // isn't guaranteed to run. Two seconds of staleness in an analytics
    // mirror is not worth that complexity.
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [])

  return null
}
