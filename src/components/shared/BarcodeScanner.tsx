'use client'

import * as React from 'react'
import { ScanLine, Camera } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  createScanDetector,
  normalizeBarcode,
  SCAN_MAX_INTERKEY_MS,
  type ScanTiming,
} from '@/types/barcode'

/**
 * Listening for a barcode scanner that thinks it is a keyboard.
 *
 * The £20 scanner on a studio counter is an HID device: no driver, no
 * permission prompt, no pairing beyond plugging it in. It reads a code and
 * *types* it, then presses Enter. Nothing tells the page a scan happened — so
 * this listens to every keystroke on the document and decides, from the timing
 * alone, whether a machine or a person produced it.
 *
 * See src/types/barcode.ts for the threshold and why it is where it is. The
 * short version: scanners emit under 35 ms apart, humans over 60 ms, and every
 * gap in the burst has to clear the line, terminator included.
 */

export interface WedgeScan {
  /** Digits only, ready to look up. */
  code: string
  /** Exactly what was typed, before normalisation. */
  raw: string
  timing: ScanTiming
  /** Where the scanner's keystrokes landed, if anywhere. */
  target: HTMLElement | null
}

export interface BarcodeScannerOptions {
  onScan: (scan: WedgeScan) => void
  /** Stop listening — e.g. while a modal owns the keyboard. */
  enabled?: boolean
  /**
   * Skip scans aimed at a field that wants to capture the raw code itself
   * (anything inside `[data-barcode-capture]`). Without this the page-level
   * handler and a barcode input would both act on the same scan.
   */
  respectCaptureFields?: boolean
}

/**
 * A page-level scan listener.
 *
 * Capture phase, so the burst can be swallowed before React's own handlers see
 * the Enter — otherwise a scan into a search box submits whatever form it is
 * sitting in.
 */
export function useBarcodeScanner({
  onScan,
  enabled = true,
  respectCaptureFields = true,
}: BarcodeScannerOptions): void {
  const handler = React.useRef(onScan)
  React.useEffect(() => {
    handler.current = onScan
  }, [onScan])

  React.useEffect(() => {
    if (!enabled) return

    const detector = createScanDetector()

    const onKeyDown = (event: KeyboardEvent) => {
      // A chorded key is a person reaching for a shortcut, never a scanner.
      if (event.ctrlKey || event.metaKey || event.altKey) {
        detector.reset()
        return
      }

      const target = event.target instanceof HTMLElement ? event.target : null
      if (respectCaptureFields && target?.closest('[data-barcode-capture]')) {
        detector.reset()
        return
      }

      const scan = detector.feed(event.key, event.timeStamp || performance.now())
      if (!scan) return

      // The Enter is the scanner's, not the operator's — do not let it submit
      // the form the cursor happens to be in.
      event.preventDefault()
      event.stopPropagation()

      const code = normalizeBarcode(scan.raw)
      if (!code) return

      clearWedgeArtifact(target, scan.raw)
      handler.current({ code, raw: scan.raw, timing: scan.timing, target })
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [enabled, respectCaptureFields])
}

/**
 * Take the scanner's digits back out of whatever field they landed in.
 *
 * There is no way to know a burst is a scan until the Enter arrives, by which
 * point the characters are already in the focused input. Setting `.value`
 * directly would leave React's copy of the state stale, so this goes through
 * the native setter and fires the input event React actually listens for.
 */
export function clearWedgeArtifact(target: HTMLElement | null, typed: string): void {
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return
  if (!target.value.endsWith(typed)) return

  const next = target.value.slice(0, target.value.length - typed.length)
  const prototype =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set

  if (setter) setter.call(target, next)
  else target.value = next

  target.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * The line that tells staff the scanner is live.
 *
 * Worth the space: a keyboard wedge is invisible, and the difference between
 * "no scanner plugged in" and "scanning does nothing on this page" is
 * otherwise unanswerable from the counter.
 */
export function BarcodeScanHint({
  label,
  lastCode,
  onOpenCamera,
  className,
}: {
  label: string
  lastCode?: string | null
  onOpenCamera?: () => void
  className?: string
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-3 border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 ${className ?? ''}`}
    >
      <ScanLine className="h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={1.75} aria-hidden />
      <p className="min-w-0 flex-1 text-xs text-[var(--color-muted)]">
        {label}{' '}
        <span className="whitespace-nowrap">
          Any handheld scanner works — it just types.
        </span>
        {lastCode && (
          <span className="mt-0.5 block tabular-nums">Last scan: {lastCode}</span>
        )}
      </p>
      {onOpenCamera && (
        <Button type="button" size="sm" variant="subtle" onClick={onOpenCamera}>
          <Camera className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          Use camera
        </Button>
      )}
    </div>
  )
}

/** Exported so a UI can explain the rule rather than restate the number. */
export const WEDGE_THRESHOLD_MS = SCAN_MAX_INTERKEY_MS
