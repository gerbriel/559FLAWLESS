'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'

/**
 * The sales tax applied to in-store product sales.
 *
 * Entered as a percentage because that is how a tax rate is quoted and written
 * on a receipt, and stored as a fraction because that is what the arithmetic
 * needs. Getting those two confused puts 835% on a sale, so the conversion
 * happens here and the database refuses anything above 30% regardless.
 */
export function SalesTaxForm({ rate }: { rate: number }) {
  const router = useRouter()
  const [percent, setPercent] = useState((rate * 100).toFixed(2).replace(/\.?0+$/, ''))
  const [busy, setBusy] = useState(false)

  async function save(e: React.FormEvent) {
    e.preventDefault()

    const asPercent = Number(percent.replace(/[%\s]/g, ''))
    if (!Number.isFinite(asPercent) || asPercent < 0) {
      toast.error('Enter the rate as a percentage, e.g. 8.35')
      return
    }
    if (asPercent >= 30) {
      toast.error('That is above 30% — check the figure.')
      return
    }

    setBusy(true)
    const { error } = await createClient().rpc('set_sales_tax_rate', {
      p_rate: asPercent / 100,
    })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not save that rate.')
      return
    }

    toast.success(`Sales tax set to ${asPercent}%.`)
    router.refresh()
  }

  return (
    <form onSubmit={save} className="max-w-sm">
      <Field
        label="Sales tax"
        htmlFor="tax_rate"
        hint="As a percentage. Fresno County is 8.35%. Applied to product sales at the counter — services are not taxed."
      >
        <div className="flex items-center gap-2">
          <Input
            id="tax_rate"
            inputMode="decimal"
            required
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
          />
          <span className="text-[var(--color-muted)]">%</span>
        </div>
      </Field>

      <Button type="submit" size="sm" className="mt-4" disabled={busy}>
        {busy ? 'Saving…' : 'Save rate'}
      </Button>
    </form>
  )
}
