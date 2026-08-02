'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Barcode as BarcodeIcon, Camera } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { normalizeBarcode, isValidGtin } from '@/types/barcode'
import { BarcodeCameraScanner } from './BarcodeCameraScanner'

/**
 * The barcode on one product.
 *
 * Standalone rather than folded into the product editor, because the code on
 * the bottle is not a studio setting the way a price or a shelf is — it is a
 * fact about the packaging, and the only thing that ever needs to change it is
 * "this is a different bottle now".
 *
 * The field carries `data-barcode-capture` so a page-level scan listener leaves
 * it alone: while this input has focus, a scanner typing into it and pressing
 * Enter should fill the field and save, not be intercepted and looked up.
 */

export function BarcodeField({
  productId,
  productName,
  initialBarcode,
  onSaved,
}: {
  productId: number
  productName?: string
  /** Skip the read if the caller already has it. */
  initialBarcode?: string | null
  onSaved?: (barcode: string | null) => void
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [value, setValue] = React.useState(initialBarcode ?? '')
  const [saved, setSaved] = React.useState<string | null>(initialBarcode ?? null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [camera, setCamera] = React.useState(false)
  const [loaded, setLoaded] = React.useState(initialBarcode !== undefined)

  // Only read when the caller could not tell us. The editor is usually opened
  // one row at a time, so this is one small query, not one per product on the
  // page.
  React.useEffect(() => {
    if (loaded || !open) return
    let cancelled = false
    void (async () => {
      const { data } = await createClient()
        .from('products')
        .select('barcode')
        .eq('id', productId)
        .maybeSingle()
      if (cancelled) return
      const current = (data as { barcode?: string | null } | null)?.barcode ?? null
      setSaved(current)
      setValue(current ?? '')
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [loaded, open, productId])

  async function write(next: string | null) {
    setBusy(true)
    setError(null)

    // Selecting the row back is how a refusal becomes visible: RLS does not
    // error on an update that matches nothing, it simply changes nothing.
    const { data, error: writeError } = await createClient()
      .from('products')
      .update({ barcode: next })
      .eq('id', productId)
      .select('id, barcode')

    setBusy(false)

    if (writeError) {
      if (writeError.code === '23505') {
        setError('Another product already has that barcode.')
      } else if (writeError.code === '23514') {
        setError('A barcode is 8 to 14 digits.')
      } else {
        setError(writeError.message || 'Could not save that barcode.')
      }
      return
    }

    if (!data || data.length === 0) {
      setError('Only a manager can change a barcode.')
      return
    }

    const stored = (data[0] as { barcode: string | null }).barcode
    setSaved(stored)
    setValue(stored ?? '')
    onSaved?.(stored)
    toast.success(stored ? 'Barcode saved.' : 'Barcode cleared.')
    router.refresh()
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const code = normalizeBarcode(value)
    if (!code) {
      void write(null)
      return
    }
    if (code.length < 8 || code.length > 14) {
      setError('A barcode is 8 to 14 digits — check you scanned the whole thing.')
      return
    }
    void write(code)
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 py-1 text-left text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
      >
        <BarcodeIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="tabular-nums">{saved ?? 'No barcode'}</span>
        <span className="sr-only">
          — set the barcode for {productName ?? 'this product'}
        </span>
      </button>
    )
  }

  return (
    <div
      data-barcode-capture
      className="space-y-3 border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left"
    >
      <p className="label-caps text-[var(--color-muted)]">Barcode</p>

      <form onSubmit={submit} className="space-y-3">
        <Field
          label="On the packaging"
          htmlFor={`barcode_${productId}`}
          hint="Scan it with the field focused, or type the digits under the bars."
          error={error ?? undefined}
        >
          <Input
            id={`barcode_${productId}`}
            inputMode="numeric"
            autoComplete="off"
            maxLength={20}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            placeholder="0123456789012"
          />
        </Field>

        {value.length > 0 &&
          normalizeBarcode(value) &&
          !isValidGtin(normalizeBarcode(value)!) && (
            <p className="text-xs text-[var(--color-muted)]">
              The check digit does not match a standard UPC/EAN. That is fine for an
              in-house label — worth a second scan if it came off a bottle.
            </p>
          )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" size="sm" variant="subtle" onClick={() => setCamera(true)}>
            <Camera className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            Camera
          </Button>
          {saved && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void write(null)}
            >
              Clear
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </form>

      {camera && (
        <BarcodeCameraScanner
          title={productName ? `Scan ${productName}` : 'Scan a barcode'}
          onClose={() => setCamera(false)}
          onDetect={(code) => {
            setValue(code)
            setError(null)
            setCamera(false)
          }}
        />
      )}
    </div>
  )
}
