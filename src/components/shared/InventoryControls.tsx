'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { FilterPills, Stepper, type PillOption } from '@/components/ui/dashboard-client'

/**
 * The two parts of the inventory list that need a handler.
 *
 * The page itself stays a Server Component: it holds the catalogue, the role
 * gates and the cost column, and only these two pieces cross into the browser.
 * That is deliberate rather than tidy — turning the whole list into a client
 * component would serialise every product's `cost_cents` into the page for
 * anyone on staff, and wholesale cost is the managers' business.
 */

/** How long a burst of taps is given to settle before it is written. */
const SETTLE_MS = 900

/**
 * The filter row, as links in all but name.
 *
 * A filtered list that lives in the URL survives a refresh, can be sent to
 * someone, and is what the barcode scanner already navigates to when the code
 * it read is outside the current view.
 */
export function InventoryFilterPills({
  options,
  value,
  search,
  className,
}: {
  options: PillOption[]
  value: string
  /** Carried across so changing filter does not silently drop the search. */
  search?: string
  className?: string
}) {
  const router = useRouter()

  return (
    <FilterPills
      label="Filter stock"
      options={options}
      value={value}
      onChange={(next) => {
        const params = new URLSearchParams({ filter: next })
        if (search) params.set('q', search)
        // `focus` is deliberately not carried: it is a one-shot instruction
        // from the scanner to jump to a row, not a state of the list.
        router.push(`/dashboard/inventory?${params.toString()}`)
      }}
      // The kit sizes its pills for a mouse. On a phone they get the same 44px
      // the shared Button gives itself.
      className={cn('[&>button]:min-h-11 sm:[&>button]:min-h-9', className)}
    />
  )
}

/**
 * Minus, the count, plus — on the row, where the bottle is.
 *
 * Every change goes through `adjust_stock`, the same RPC the product editor
 * uses: it moves the balance and writes the log row in one statement so the two
 * can never drift, and it tells the managers afterwards. There is no approval
 * step to bypass — migration 021 retired the queue for stock on the grounds
 * that whoever is holding the bottle is the person who knows the number, and
 * 032 kept it retired when stock moved to `product_stock`.
 *
 * Taps are gathered and written once. Tapping plus four times is one delivery,
 * not four; sending it as four calls would be four log rows and four
 * notifications for a single act of counting.
 */
export function StockStepper({
  productId,
  productName,
  unit,
  quantity,
  canCount,
}: {
  productId: number
  productName: string
  unit: string
  quantity: number
  /** False leaves the number readable and the buttons dead. */
  canCount: boolean
}) {
  const router = useRouter()
  const [value, setValue] = React.useState(quantity)
  const pending = React.useRef(0)
  const timer = React.useRef<number | null>(null)

  // A refresh brings the authoritative count back from the database. Take it,
  // unless taps of ours are still waiting to be written — those are newer.
  React.useEffect(() => {
    if (pending.current === 0) setValue(quantity)
  }, [quantity])

  const flush = React.useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }

    const delta = pending.current
    pending.current = 0
    if (delta === 0) return

    // A tap on this row is a recount, which is exactly what count_correction
    // means. A delivery or a breakage wants the reason picker in the editor.
    const { data, error } = await createClient().rpc('adjust_stock', {
      p_product_id: productId,
      p_change: delta,
      p_reason: 'count_correction',
      p_note: 'Counted on the inventory list',
    })

    if (error) {
      setValue(quantity)
      toast.error(error.message || `Could not change the count for ${productName}.`)
    } else {
      toast.success(`${productName} is now ${data} ${unit}.`)
    }

    router.refresh()
  }, [productId, productName, quantity, unit, router])

  // Walking away is not a reason to lose a count, so a pending change is
  // written on the way out too. It returns immediately when nothing is owed.
  const latestFlush = React.useRef(flush)
  React.useEffect(() => {
    latestFlush.current = flush
  }, [flush])
  React.useEffect(
    () => () => {
      void latestFlush.current()
    },
    []
  )

  function handleChange(next: number) {
    const delta = next - value
    if (delta === 0) return

    pending.current += delta
    setValue(next)

    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void flush()
    }, SETTLE_MS)
  }

  return (
    <div
      // Leaving the control is a firmer "done" than the timer, so it writes at
      // once rather than making someone wait for a toast they have earned.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) void flush()
      }}
      // 44px under a thumb, the kit's 36px under a cursor — the same pair of
      // sizes the shared Button uses.
      className="[&_button]:h-11 [&_button]:w-11 [&_input]:h-11 sm:[&_button]:h-9 sm:[&_button]:w-9 sm:[&_input]:h-9"
    >
      <Stepper
        value={value}
        onChange={handleChange}
        min={0}
        disabled={!canCount}
        label={`${productName} on hand, in ${unit}`}
      />
    </div>
  )
}
