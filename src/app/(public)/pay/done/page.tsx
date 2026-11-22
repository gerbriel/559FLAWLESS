import type { Metadata } from 'next'
import { CheckCircle } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Thank you',
  robots: { index: false, follow: false },
}

/**
 * Where a client's phone lands after paying a till sale by phone (090).
 *
 * It proves nothing and records nothing: the webhook is what marks the sale
 * paid, and the till updates from that. This page only tells the client they
 * are done.
 */
export default function PayDonePage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-20">
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-12 text-center">
        <CheckCircle className="mx-auto h-12 w-12 text-green-600 dark:text-green-400" strokeWidth={1.5} aria-hidden />
        <h1 className="display mt-6 text-3xl">Thank you</h1>
        <p className="mt-4 text-[var(--color-muted)]">You can hand the phone back. The studio will see your payment in a moment.</p>
      </div>
    </div>
  )
}
