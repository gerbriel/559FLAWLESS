'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { barcodeVariants, matchProductByBarcode } from '@/types/barcode'
import { BarcodeScanHint, useBarcodeScanner } from './BarcodeScanner'
import { BarcodeCameraScanner } from './BarcodeCameraScanner'

/**
 * Scanning on the inventory page: find the bottle, open its counter.
 *
 * Counting stock is the job this is for. Someone works along a shelf with a
 * scanner in one hand, and every scan should land them on that product's
 * adjuster with the cursor already in the box — no searching, no scrolling, no
 * losing their place.
 *
 * A code that is on file but filtered out of the current view is not an error:
 * the page reopens on All with that row focused, which is what "show me this
 * one" means.
 */

export interface InventoryScanRow {
  id: number
  name: string
  barcode: string | null
  sku: string | null
  stock_qty: number
  unit: string
}

/** Wait for the row's editor to render, then put the cursor in the amount box. */
function focusAdjuster(productId: number, attempts = 20) {
  const input = document.getElementById(`change_${productId}`)
  if (input instanceof HTMLInputElement) {
    input.focus()
    input.select()
    return
  }
  if (attempts <= 0) return
  window.setTimeout(() => focusAdjuster(productId, attempts - 1), 30)
}

function jumpToRow(productId: number): boolean {
  const row = document.querySelector<HTMLElement>(`[data-product-row="${productId}"]`)
  if (!row) return false

  row.scrollIntoView({ behavior: 'smooth', block: 'center' })
  row.classList.add('bg-[var(--color-clay-soft)]')
  window.setTimeout(() => row.classList.remove('bg-[var(--color-clay-soft)]'), 2200)

  // Already open — clicking would be the close button.
  if (!document.getElementById(`change_${productId}`)) {
    row.querySelector<HTMLButtonElement>('[data-product-edit] button')?.click()
  }
  focusAdjuster(productId)
  return true
}

export function BarcodeInventoryScan({
  rows,
  focusId,
}: {
  rows: InventoryScanRow[]
  /** Set by ?focus= after a scan landed on a product the filter was hiding. */
  focusId?: number | null
}) {
  const router = useRouter()
  const [lastCode, setLastCode] = React.useState<string | null>(null)
  const [camera, setCamera] = React.useState(false)

  const rowsRef = React.useRef(rows)
  React.useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  React.useEffect(() => {
    if (focusId == null) return
    // One frame, so the table it is looking for exists.
    const id = window.setTimeout(() => jumpToRow(focusId), 0)
    return () => window.clearTimeout(id)
  }, [focusId])

  const handleCode = React.useCallback(
    async (code: string) => {
      setLastCode(code)

      const here = matchProductByBarcode(code, rowsRef.current)
      if (here) {
        if (jumpToRow(here.id)) return
      }

      // Not on screen. It may still be on file — back bar while the Retail
      // filter is on, most likely.
      const variants = barcodeVariants(code)
      const { data } = await createClient()
        .from('products')
        .select('id, name, barcode, is_active, archived_at')
        .in('barcode', variants)
        .limit(1)

      const found = (data ?? [])[0] as
        | { id: number; name: string; is_active: boolean; archived_at: string | null }
        | undefined

      if (!found) {
        toast.error(`No product carries the barcode ${code}.`, {
          description: 'Open a product and save the code against it first.',
        })
        return
      }

      if (found.archived_at || !found.is_active) {
        toast.error(`${found.name} is archived.`)
        return
      }

      toast.message(`${found.name} is outside this filter.`, {
        description: 'Showing all stock.',
      })
      router.push(`/dashboard/inventory?filter=all&focus=${found.id}`)
    },
    [router]
  )

  useBarcodeScanner({
    enabled: !camera,
    onScan: (scan) => {
      void handleCode(scan.code)
    },
  })

  const withBarcode = rows.filter((r) => r.barcode).length

  return (
    <>
      <BarcodeScanHint
        className="mt-8"
        label={
          withBarcode === 0
            ? 'Scan a barcode to jump to a product. None of these have one saved yet — open a row to add it.'
            : `Scan a barcode to jump straight to its stock adjuster. ${withBarcode} of ${rows.length} here have one saved.`
        }
        lastCode={lastCode}
        onOpenCamera={() => setCamera(true)}
      />

      {camera && (
        <BarcodeCameraScanner
          title="Find a product"
          onClose={() => setCamera(false)}
          onDetect={(code) => {
            setCamera(false)
            void handleCode(code)
          }}
        />
      )}
    </>
  )
}
