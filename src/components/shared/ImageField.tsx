'use client'

import * as React from 'react'
import Image from 'next/image'
import { toast } from 'sonner'
import { ImagePlus, Link2, Trash2, GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

/**
 * Pick a picture, for anything the studio publishes.
 *
 * Products, services and announcements all carry an `image_url`, and until now
 * the only way to set one was to already have a URL — which meant the studio
 * could not add a photograph of her own work without a detour through some
 * other host. This is the file picker that was missing, and it does the two
 * things a picture field has to do here:
 *
 *   UPLOAD, to one of the public buckets 011 created. Manager and above, which
 *   is what those buckets' own policies say, so this cannot be used to get
 *   around them — a provider gets no button.
 *
 *   PASTE A URL, still. Forty of the retail products point at Rhonda Allison's
 *   own CDN (see migration 017), and that is correct: the brand photographs its
 *   own bottles better than a phone on a countertop will, and copying those
 *   files into this project would be republishing somebody else's photography.
 *   A field that only accepted uploads would quietly invite someone to replace
 *   them.
 *
 * Saving is the caller's job. This hands back a URL and the form it sits in
 * decides when that becomes a row — so opening an editor, changing a picture
 * and pressing Cancel does not leave the change behind. The one cost is an
 * orphaned file in the bucket when someone uploads and then cancels; a stray
 * 200 KB in a public bucket is a better failure than a save nobody asked for.
 */

export type ImageBucket = 'site' | 'products'

const MAX_BYTES = 10 * 1024 * 1024
const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif'

/** Uploads one file and returns its public URL, or null if it failed. */
async function uploadTo(bucket: ImageBucket, folder: string, file: File): Promise<string | null> {
  if (file.size > MAX_BYTES) {
    toast.error(`${file.name} is over 10 MB. The bucket will refuse it.`)
    return null
  }

  const supabase = createClient()
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
  // A random filename rather than the original: replacing a picture then never
  // has to fight a CDN cache, and two people uploading "IMG_0042.jpg" on the
  // same afternoon do not collide.
  const path = `${folder}/${crypto.randomUUID()}.${ext}`

  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: '31536000',
    contentType: file.type,
  })

  if (error) {
    // The bucket policies are `is_manager()`. A provider who reaches this at all
    // gets the storage layer's refusal, which is the honest answer.
    toast.error(
      /row-level security|not authorized/i.test(error.message)
        ? 'Your account cannot upload pictures — that is a manager action.'
        : error.message || 'Could not upload that image.'
    )
    return null
  }

  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
}

/* ── One picture ──────────────────────────────────────────── */

export function ImageField({
  value,
  onChange,
  bucket,
  folder,
  label = 'Picture',
  hint,
  aspect = 'square',
  disabled,
  className,
}: {
  value: string | null
  onChange: (url: string | null) => void
  bucket: ImageBucket
  /** Path prefix inside the bucket — 'services', 'products', 'announcements'. */
  folder: string
  label?: string
  hint?: React.ReactNode
  aspect?: 'square' | 'wide'
  disabled?: boolean
  className?: string
}) {
  const [busy, setBusy] = React.useState(false)
  const [pasting, setPasting] = React.useState(false)
  const [url, setUrl] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  async function take(file: File) {
    setBusy(true)
    const next = await uploadTo(bucket, folder, file)
    setBusy(false)
    if (next) {
      onChange(next)
      toast.success('Picture uploaded. It saves with the rest of the form.')
    }
  }

  return (
    <div className={className}>
      <p className="label-caps mb-2 text-[var(--color-muted)]">{label}</p>

      <div className="flex flex-wrap items-start gap-4">
        <div
          data-ui="tile"
          className={cn(
            'relative shrink-0 overflow-hidden border border-[var(--color-border)] bg-[var(--color-linen)] dark:bg-[var(--color-background)]',
            aspect === 'wide' ? 'h-24 w-40' : 'h-24 w-24'
          )}
        >
          {value ? (
            <Image
              src={value}
              alt=""
              fill
              sizes="160px"
              // `contain` because a product shot is a bottle on nothing and a
              // crop would cut it. Announcements are the exception and pass
              // `wide`, where a cover crop is what the banner actually does.
              className={aspect === 'wide' ? 'object-cover' : 'object-contain p-2'}
              // Off, because these URLs point at several hosts — the studio's
              // own bucket and two brand CDNs — and the optimiser is configured
              // per host in next.config.ts.
              unoptimized
            />
          ) : (
            <ImagePlus
              className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-[var(--color-muted)]"
              strokeWidth={1.25}
              aria-hidden
            />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="subtle"
              disabled={disabled || busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? 'Uploading…' : value ? 'Replace' : 'Upload'}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || busy}
              onClick={() => setPasting((p) => !p)}
            >
              <Link2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
              Use a link
            </Button>

            {value && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled || busy}
                onClick={() => onChange(null)}
                className="text-[var(--color-muted)] hover:text-red-700"
              >
                Remove
              </Button>
            )}

            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              disabled={disabled || busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                // Cleared so choosing the same file twice fires again.
                e.target.value = ''
                if (file) void take(file)
              }}
            />
          </div>

          {pasting && (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                data-ui="input"
                className="min-h-9 min-w-0 flex-1 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <Button
                type="button"
                size="sm"
                variant="subtle"
                disabled={!url.trim()}
                onClick={() => {
                  const trimmed = url.trim()
                  // Only http(s). A `data:` or `javascript:` URL in a column
                  // that becomes an <img src> on the public site is not
                  // something to find out about later.
                  if (!/^https?:\/\//i.test(trimmed)) {
                    toast.error('That needs to be a full http:// or https:// address.')
                    return
                  }
                  onChange(trimmed)
                  setUrl('')
                  setPasting(false)
                }}
              >
                Use it
              </Button>
            </div>
          )}

          {hint && <p className="mt-2 text-xs text-[var(--color-muted)]">{hint}</p>}

          {/* Worth saying once: a host the optimiser does not know about
              renders, but Next will refuse to optimise it. */}
          {value && !pasting && (
            <p className="mt-2 truncate text-xs text-[var(--color-muted)]">{value}</p>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Several pictures ─────────────────────────────────────── */

/**
 * The extra shots, for a product page that wants more than one.
 *
 * `products.gallery` is a jsonb array of URLs and has existed since 007 with no
 * way to put anything in it. Order matters — it is the order they appear — so
 * this offers moving one earlier or later rather than a drag surface, which is
 * a great deal of code for a list that will rarely hold more than four.
 */
export function ImageGalleryField({
  value,
  onChange,
  bucket,
  folder,
  label = 'More pictures',
  hint,
  disabled,
  className,
}: {
  value: string[]
  onChange: (urls: string[]) => void
  bucket: ImageBucket
  folder: string
  label?: string
  hint?: React.ReactNode
  disabled?: boolean
  className?: string
}) {
  const [busy, setBusy] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  async function take(files: FileList) {
    setBusy(true)
    const added: string[] = []
    // Sequential: a phone selecting eight photographs at once should not open
    // eight concurrent uploads on studio wifi.
    for (const file of Array.from(files)) {
      const url = await uploadTo(bucket, folder, file)
      if (url) added.push(url)
    }
    setBusy(false)
    if (added.length > 0) {
      onChange([...value, ...added])
      toast.success(`${added.length} added. They save with the rest of the form.`)
    }
  }

  function move(index: number, by: -1 | 1) {
    const next = [...value]
    const to = index + by
    if (to < 0 || to >= next.length) return
    ;[next[index], next[to]] = [next[to], next[index]]
    onChange(next)
  }

  return (
    <div className={className}>
      <p className="label-caps mb-2 text-[var(--color-muted)]">{label}</p>

      {value.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-2.5">
          {value.map((url, i) => (
            <li key={`${url}-${i}`} className="w-24">
              <div
                data-ui="tile"
                className="relative h-24 w-24 overflow-hidden border border-[var(--color-border)] bg-[var(--color-linen)] dark:bg-[var(--color-background)]"
              >
                <Image
                  src={url}
                  alt=""
                  fill
                  sizes="96px"
                  className="object-contain p-1.5"
                  unoptimized
                />
                <button
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => onChange(value.filter((_, n) => n !== i))}
                  className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-surface)]/90 text-[var(--color-muted)] hover:text-red-700"
                  aria-label={`Remove picture ${i + 1}`}
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </div>

              <div className="mt-1 flex items-center justify-center gap-1">
                <button
                  type="button"
                  disabled={disabled || busy || i === 0}
                  onClick={() => move(i, -1)}
                  className="flex h-7 w-7 items-center justify-center text-sm text-[var(--color-muted)] disabled:opacity-30"
                  aria-label={`Move picture ${i + 1} earlier`}
                >
                  ←
                </button>
                <GripVertical
                  className="h-3 w-3 text-[var(--color-border)]"
                  strokeWidth={1.5}
                  aria-hidden
                />
                <button
                  type="button"
                  disabled={disabled || busy || i === value.length - 1}
                  onClick={() => move(i, 1)}
                  className="flex h-7 w-7 items-center justify-center text-sm text-[var(--color-muted)] disabled:opacity-30"
                  aria-label={`Move picture ${i + 1} later`}
                >
                  →
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Button
        type="button"
        size="sm"
        variant="subtle"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? 'Uploading…' : 'Add pictures'}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        disabled={disabled || busy}
        onChange={(e) => {
          const files = e.target.files
          e.target.value = ''
          if (files && files.length > 0) void take(files)
        }}
      />

      {hint && <p className="mt-2 text-xs text-[var(--color-muted)]">{hint}</p>}
    </div>
  )
}
