'use client'

import { useState } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export function AnnouncementBar({
  id,
  title,
  linkUrl,
  linkLabel,
  variant,
}: {
  id: number
  title: string
  linkUrl: string | null
  linkLabel: string | null
  variant: 'info' | 'promo' | 'urgent'
}) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  return (
    <div
      className={cn(
        'relative px-6 py-2.5 text-center',
        variant === 'promo' && 'bg-[var(--color-accent)] text-white',
        variant === 'urgent' && 'bg-red-800 text-white',
        variant === 'info' && 'bg-[var(--color-espresso)] text-[var(--color-porcelain)]'
      )}
    >
      <p className="label-caps inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <span>{title}</span>
        {linkUrl && (
          <Link href={linkUrl} className="underline underline-offset-4">
            {linkLabel ?? 'Learn more'}
          </Link>
        )}
      </p>
      <button
        onClick={() => setDismissed(true)}
        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 opacity-70 hover:opacity-100"
        aria-label={`Dismiss announcement: ${title}`}
        data-announcement={id}
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  )
}
