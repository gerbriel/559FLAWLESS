'use client'

import { useEffect } from 'react'

/**
 * The boundary of last resort: it renders when the ROOT LAYOUT itself failed,
 * which means globals.css, the fonts and every provider may be gone. So no
 * Tailwind classes, no next/link, no design tokens — inline styles that need
 * nothing to have survived, in roughly the studio's palette so it still reads
 * as the same establishment on its worst day.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#faf7f4',
          color: '#2b211e',
          fontFamily: 'Georgia, serif',
          textAlign: 'center',
          padding: '2rem',
        }}
      >
        <div style={{ maxWidth: '28rem' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 400, margin: 0 }}>
            559 Flawless is having a moment
          </h1>
          <p style={{ color: '#7a6a63', lineHeight: 1.6, marginTop: '1rem' }}>
            Something failed on our side and the page could not load at all. Nothing about
            your appointment has been lost.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '2rem',
              padding: '0.75rem 1.5rem',
              border: '1px solid #2b211e',
              background: 'transparent',
              color: '#2b211e',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p style={{ marginTop: '2rem', fontSize: '0.75rem', color: '#7a6a63' }}>
              Reference: <code>{error.digest}</code>
            </p>
          )}
        </div>
      </body>
    </html>
  )
}
