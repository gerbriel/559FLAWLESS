import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Payment not taken',
  robots: { index: false, follow: false },
}

/** Where a client's phone lands if they back out of a till payment link (090). */
export default function PayCancelledPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-20">
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-12 text-center">
        <h1 className="display text-3xl">Nothing was charged</h1>
        <p className="mt-4 text-[var(--color-muted)]">
          The payment was not taken. You can scan the code at the counter again, or pay another way.
        </p>
      </div>
    </div>
  )
}
