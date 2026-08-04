import Link from 'next/link'

/**
 * The fourteen notFound() call sites — a retired service slug, a shop link
 * from an old text, a mistyped address — all land here instead of on Next's
 * default 404. A wrong address on a booking site should end at the two places
 * a visitor was probably trying to reach.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] items-center justify-center px-6 py-24">
      <div className="max-w-md text-center">
        <p className="label-caps mb-6 text-[var(--color-accent)]">Page not found</p>
        <h1 className="display text-4xl">That page isn&rsquo;t here</h1>
        <p className="mt-4 text-[var(--color-muted)]">
          The link may be old — treatments and products move around as the menu changes.
          What you&rsquo;re after is probably one of these.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-6">
          <Link href="/services" className="label-caps border-b border-[var(--color-foreground)] pb-1">
            The menu
          </Link>
          <Link href="/book" className="label-caps border-b border-[var(--color-foreground)] pb-1">
            Book a visit
          </Link>
          <Link href="/" className="label-caps pb-1 text-[var(--color-muted)]">
            Home
          </Link>
        </div>
      </div>
    </main>
  )
}
