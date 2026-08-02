'use client'

import * as React from 'react'
import { X, Camera } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { normalizeBarcode, isValidGtin } from '@/types/barcode'

/**
 * Reading a barcode with the camera.
 *
 * The secondary path, deliberately. A handheld scanner is faster, more
 * accurate and does not need the studio to hold a phone at the right distance
 * while a client waits — so this is for the case where there is no scanner to
 * hand: counting stock on the shelf, or checking a bottle in the treatment
 * room.
 *
 * No library. The browser's own `BarcodeDetector` does this natively in Chrome
 * and Edge on desktop and Android, which covers the phone in a pocket. Safari
 * and Firefox have not shipped it, and rather than pull in a WASM decoder to
 * paper over that, those browsers get an honest message and a field to type the
 * number into — the same number, reaching the same lookup.
 */

interface DetectedBarcode {
  rawValue: string
  format: string
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

/** The retail symbologies. Narrowing the list makes detection faster. */
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'code_128']

/** Four frames a second. Enough to feel instant, cheap enough not to cook a phone. */
const FRAME_INTERVAL_MS = 250

/** How long the same code is ignored after it reads. */
const REPEAT_GUARD_MS = 2500

function detectorConstructor(): BarcodeDetectorConstructor | null {
  if (typeof window === 'undefined') return null
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector
  return typeof ctor === 'function' ? ctor : null
}

export function BarcodeCameraScanner({
  onDetect,
  onClose,
  title = 'Scan a barcode',
}: {
  /** Return true to close the scanner; false keeps it open for another read. */
  onDetect: (code: string) => boolean | void | Promise<boolean | void>
  onClose: () => void
  title?: string
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  // A capability, not state — read straight from the browser rather than
  // written into React by an effect. The server snapshot is `false` so the
  // markup that renders before hydration is the one that needs no camera.
  const supported = React.useSyncExternalStore(
    () => () => {},
    () => detectorConstructor() !== null && Boolean(navigator.mediaDevices?.getUserMedia),
    () => false
  )
  const [error, setError] = React.useState<string | null>(null)
  const [manual, setManual] = React.useState('')
  const [manualError, setManualError] = React.useState<string | null>(null)

  const onDetectRef = React.useRef(onDetect)
  React.useEffect(() => {
    onDetectRef.current = onDetect
  }, [onDetect])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  React.useEffect(() => {
    const Ctor = detectorConstructor()
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) return

    let stream: MediaStream | null = null
    let timer: number | null = null
    let stopped = false

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()

        const detector = new Ctor({ formats: FORMATS })

        // The same bottle stays in frame for a second or two after it reads.
        // Without this, a scanner left open would add it four times a second.
        let lastCode = ''
        let lastAt = 0

        const tick = async () => {
          if (stopped || !videoRef.current || videoRef.current.readyState < 2) return
          try {
            const found = await detector.detect(videoRef.current)
            const code = normalizeBarcode(found[0]?.rawValue)
            if (!code) return
            const at = performance.now()
            if (code === lastCode && at - lastAt < REPEAT_GUARD_MS) return
            lastCode = code
            lastAt = at

            const keepOpen = (await onDetectRef.current(code)) === false
            if (!keepOpen) {
              stopped = true
              return
            }
          } catch {
            // A frame that will not decode is the normal case, not an error.
          }
        }

        timer = window.setInterval(tick, FRAME_INTERVAL_MS)
      } catch (err) {
        setError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'The camera was blocked. Allow it in your browser settings, or type the number below.'
            : 'The camera could not be started. Type the number below instead.'
        )
      }
    }

    void start()

    return () => {
      stopped = true
      if (timer !== null) window.clearInterval(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function submitManual(e: React.FormEvent) {
    e.preventDefault()
    const code = normalizeBarcode(manual)
    if (!code || code.length < 8) {
      setManualError('A barcode is at least 8 digits.')
      return
    }
    setManualError(null)
    void onDetectRef.current(code)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="camera_scan_title"
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          aria-label="Close"
        >
          <X className="h-4 w-4" strokeWidth={1.5} />
        </button>

        <h2 id="camera_scan_title" className="display flex items-center gap-2 text-2xl">
          <Camera className="h-5 w-5 text-[var(--color-muted)]" strokeWidth={1.5} aria-hidden />
          {title}
        </h2>

        {!supported ? (
          <p className="mt-4 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-3 text-sm text-[var(--color-muted)] dark:bg-[var(--color-background)]">
            This browser cannot read barcodes from the camera — Safari and Firefox have not
            added it yet. A handheld scanner works everywhere, and the number underneath the
            bars can be typed in below.
          </p>
        ) : (
          <>
            <div className="mt-4 aspect-video w-full overflow-hidden bg-black">
              <video
                ref={videoRef}
                playsInline
                muted
                className="h-full w-full object-cover"
                aria-label="Camera preview"
              />
            </div>
            {error ? (
              <p className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>
            ) : (
              <p className="mt-3 text-xs text-[var(--color-muted)]">
                Hold the barcode steady, filling about a third of the frame.
              </p>
            )}
          </>
        )}

        <form onSubmit={submitManual} className="mt-5 border-t border-[var(--color-border)] pt-5">
          <Field
            label="Or type the number"
            htmlFor="manual_barcode"
            hint="The digits printed under the bars."
            error={manualError ?? undefined}
          >
            <Input
              id="manual_barcode"
              inputMode="numeric"
              autoComplete="off"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="0123456789012"
            />
          </Field>
          {manual.length > 0 && normalizeBarcode(manual) && !isValidGtin(normalizeBarcode(manual)!) && (
            <p className="mt-1.5 text-xs text-[var(--color-muted)]">
              That is not a standard check-digit match — worth a second look before saving.
            </p>
          )}
          <Button type="submit" size="sm" className="mt-4">
            Look it up
          </Button>
        </form>
      </div>
    </div>
  )
}
