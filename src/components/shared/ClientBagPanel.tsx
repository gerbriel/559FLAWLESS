'use client'

import { useState } from 'react'
import { ShoppingBag } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils'

/**
 * "In their bag" — the current contents of a client's shopping bag, on their
 * record.
 *
 * The data is `cart_snapshots` (060): product ids and quantities, one row per
 * browsing session, overwritten in place. The page reads it server-side as the
 * viewer — 060's staff SELECT policy is what says yes — joins the names and
 * today's prices from `products`, and mounts this panel ONLY when the bag has
 * something in it. A client with no bag needs no empty box saying so, which is
 * why there is no empty state here at all: no items, no panel.
 *
 * This is bag contents, deliberately not a browsing trail. "She had the serum
 * in her bag on Tuesday" is asked-for and actionable at the desk; a list of
 * pages she looked at is neither, and 060 shaped the table so it cannot be
 * one. The "on the shelf" line is the front-desk moment the owner described —
 * the thing in the bag is sitting in the studio, so it can simply be handed
 * over next visit.
 *
 * The reminder button is the client-facing nudge. Reports render server-side
 * with no row actions, so the action lives here on the record instead. The
 * route re-derives everything — role, the target's marketing consent at the
 * moment of sending (038's principle), whether a bag still exists, whether an
 * unread nudge is already waiting — so this button is an offer, never an
 * authority. It is hidden when the viewer cannot use it or the client has
 * opted out of marketing, purely so nobody presses a button that was always
 * going to refuse.
 */

export interface BagItem {
  productId: number
  name: string
  qty: number
  /** Today's `products.price_cents` — the snapshot holds ids only (rule 2). */
  priceCents: number
  /** In stock at the studio right now — worth saying out loud at the desk. */
  onShelf: boolean
}

export function ClientBagPanel({
  clientId,
  items,
  updatedAt,
  timeZone,
  canNudge,
  marketingOptIn,
}: {
  clientId: string
  items: BagItem[]
  /** ISO instant of the snapshot's last write. */
  updatedAt: string
  timeZone: string
  /** Front desk and up — the same gate the route re-checks. */
  canNudge: boolean
  marketingOptIn: boolean
}) {
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)

  if (items.length === 0) return null

  const totalCents = items.reduce((sum, i) => sum + i.priceCents * i.qty, 0)

  async function nudge() {
    setPending(true)
    const outcome = await fetch('/api/clients/cart-nudge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId }),
    })
      .then(async (res) => ({
        ok: res.ok,
        status: res.status,
        body: (await res.json().catch(() => null)) as { message?: string } | null,
      }))
      .catch(() => null)
    setPending(false)

    if (!outcome) {
      toast.error('The reminder could not be sent — try again in a moment.')
      return
    }
    if (outcome.ok) {
      setSent(true)
      toast.success('Reminder sent — it will be waiting in their account.')
      return
    }
    // A refusal arrives as a sentence; say it as it came. An unread nudge
    // already waiting means the job is done, so the button retires too.
    if (outcome.status === 409) setSent(true)
    toast.error(outcome.body?.message ?? 'The reminder was refused.')
  }

  return (
    <section
      data-ui="panel"
      className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
    >
      <h3 className="label-caps mb-5 flex items-center gap-2 text-[var(--color-accent)]">
        <ShoppingBag className="h-3.5 w-3.5" strokeWidth={2} />
        In their bag
      </h3>

      <ul className="space-y-2.5 text-sm">
        {items.map((item) => (
          <li key={item.productId} className="flex items-start justify-between gap-3">
            <span>
              {item.name}
              {item.qty > 1 && (
                <span className="text-[var(--color-muted)]"> ×{item.qty}</span>
              )}
              {item.onShelf && (
                <span className="block text-xs text-[var(--color-muted)]">On the shelf here</span>
              )}
            </span>
            <span className="shrink-0 tabular-nums">
              {formatMoney(item.priceCents * item.qty)}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-4 flex justify-between gap-4 border-t border-[var(--color-border)] pt-3 text-sm">
        <span className="text-[var(--color-muted)]">At today&rsquo;s prices</span>
        <span className="tabular-nums">{formatMoney(totalCents)}</span>
      </p>

      <p className="mt-2 text-xs text-[var(--color-muted)]">
        Updated{' '}
        {new Date(updatedAt).toLocaleDateString('en-US', {
          timeZone,
          month: 'short',
          day: 'numeric',
        })}
      </p>

      {canNudge &&
        (marketingOptIn ? (
          <div className="mt-4">
            <Button variant="subtle" size="sm" disabled={pending || sent} onClick={nudge}>
              {sent ? 'Reminder sent' : pending ? 'Sending…' : 'Send a gentle reminder'}
            </Button>
          </div>
        ) : (
          <p className="mt-4 text-xs text-[var(--color-muted)]">
            They&rsquo;ve opted out of marketing, so no reminder can be sent.
          </p>
        ))}
    </section>
  )
}
