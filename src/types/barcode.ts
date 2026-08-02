/**
 * Barcode scanning — the shapes and the pure logic behind them.
 *
 * Deliberately React-free and DOM-free so the detector can be exercised
 * directly with a list of (key, timestamp) pairs. The whole feature turns on a
 * timing judgement, and a timing judgement you cannot run without a browser is
 * a timing judgement nobody checks.
 *
 * The hardware assumption: almost every USB/Bluetooth barcode scanner sold for
 * a counter is an HID keyboard. It has no driver, asks for no permission, and
 * simply *types* the digits it read and presses Enter. So "scanning" here is
 * not a device integration — it is telling a burst of machine keystrokes apart
 * from a person typing, which is what everything below does.
 */

// ── Timing ───────────────────────────────────────────────────
//
// A scanner emits its characters 5–20 ms apart; the slowest Bluetooth HID
// bridges we could find still land under 35 ms. A human touch-typist averages
// 120–160 ms between keys and their very fastest digraph bursts sit around
// 60–80 ms — and that is on familiar letter pairs, not the number row.
//
// 50 ms is the gap between those two populations. Every gap in the burst must
// be under it, INCLUDING the gap before the terminating Enter, so passing by
// accident would mean typing eight-plus digits at over 1,200 characters per
// minute and hitting Enter inside the same window.

/** No two characters of one scan may be further apart than this. */
export const SCAN_MAX_INTERKEY_MS = 50

/** Shortest real barcode is GTIN-8. Below this it is someone typing. */
export const SCAN_MIN_LENGTH = 8

/** Above this it is not a barcode; the buffer is dropped rather than grown. */
export const SCAN_MAX_LENGTH = 32

/** Whole burst, first character to Enter. Guards against a stalled scanner. */
export const SCAN_MAX_TOTAL_MS = 800

/** Keys a scanner may be configured to send instead of Enter. */
const TERMINATORS = new Set(['Enter', 'Tab', 'NumpadEnter'])

/** Held down, not typed — these must not break a burst in progress. */
const HARMLESS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Dead'])

export interface ScanTiming {
  /** Characters in the burst. */
  length: number
  /** First character to terminator, in ms. */
  elapsedMs: number
  /** Largest gap between consecutive keystrokes, in ms. */
  maxGapMs: number
}

export interface DetectedScan {
  /** Exactly what the scanner typed, before any normalisation. */
  raw: string
  timing: ScanTiming
}

export interface ScanDetectorOptions {
  maxInterKeyMs?: number
  minLength?: number
  maxLength?: number
  maxTotalMs?: number
}

export interface ScanDetector {
  /**
   * Feed one keystroke. Returns a scan only on the keystroke that completes
   * one — every other call returns null, including the digits on the way.
   */
  feed(key: string, at: number): DetectedScan | null
  /** Characters currently buffered. Zero when nothing is in flight. */
  pending(): number
  reset(): void
}

/**
 * The state machine.
 *
 * A burst is a run of printable keys with no gap over the threshold, ended by
 * Enter or Tab. Anything slower simply starts a new burst from the key that was
 * too late, so ordinary typing rolls through here without ever accumulating
 * enough to look like a scan.
 */
export function createScanDetector(options: ScanDetectorOptions = {}): ScanDetector {
  const maxGap = options.maxInterKeyMs ?? SCAN_MAX_INTERKEY_MS
  const minLength = options.minLength ?? SCAN_MIN_LENGTH
  const maxLength = options.maxLength ?? SCAN_MAX_LENGTH
  const maxTotal = options.maxTotalMs ?? SCAN_MAX_TOTAL_MS

  let buffer = ''
  let firstAt = 0
  let lastAt = 0
  let widestGap = 0

  const clear = () => {
    buffer = ''
    firstAt = 0
    lastAt = 0
    widestGap = 0
  }

  return {
    feed(key, at) {
      if (HARMLESS.has(key)) return null

      if (TERMINATORS.has(key)) {
        const raw = buffer
        const elapsed = at - firstAt
        const closingGap = at - lastAt
        // Read before clearing — an earlier version cleared first and then
        // tested a zeroed widestGap, which made that half of the check pass
        // unconditionally.
        const observedGap = Math.max(widestGap, raw.length > 0 ? closingGap : 0)
        clear()

        if (raw.length < minLength || raw.length > maxLength) return null
        if (observedGap > maxGap) return null
        if (elapsed > maxTotal) return null

        return {
          raw,
          timing: { length: raw.length, elapsedMs: elapsed, maxGapMs: observedGap },
        }
      }

      // Anything else printable extends the burst; anything else at all
      // (Backspace, Escape, an arrow key) means a person is involved.
      if (key.length !== 1) {
        clear()
        return null
      }

      if (buffer.length === 0) {
        buffer = key
        firstAt = at
        lastAt = at
        widestGap = 0
        return null
      }

      const gap = at - lastAt
      if (gap > maxGap) {
        // Too slow to belong to what came before — this key starts a new burst.
        buffer = key
        firstAt = at
        lastAt = at
        widestGap = 0
        return null
      }

      buffer += key
      widestGap = Math.max(widestGap, gap)
      lastAt = at
      if (buffer.length > maxLength) clear()
      return null
    },
    pending: () => buffer.length,
    reset: clear,
  }
}

// ── GTIN arithmetic ──────────────────────────────────────────

/** Digits only, empty string collapsed to null. Mirrors the DB's trigger. */
export function normalizeBarcode(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[^0-9]/g, '')
  return digits.length > 0 ? digits : null
}

/**
 * The mod-10 check digit for a GTIN body (the code without its last digit).
 *
 * Weights alternate 3,1,3,1… from the rightmost body digit, which is why this
 * walks the string backwards rather than indexing from the front — the weight
 * depends on distance from the check digit, not on length.
 */
export function gtinCheckDigit(body: string): number {
  let sum = 0
  for (let i = body.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(body[i]) * weight
  }
  return (10 - (sum % 10)) % 10
}

/** True for a well-formed GTIN-8/12/13/14 whose check digit agrees. */
export function isValidGtin(code: string): boolean {
  if (!/^[0-9]+$/.test(code)) return false
  if (![8, 12, 13, 14].includes(code.length)) return false
  return gtinCheckDigit(code.slice(0, -1)) === Number(code[code.length - 1])
}

/**
 * UPC-E (8 digits) → the UPC-A (12 digits) it stands for.
 *
 * Small bottles carry UPC-E because there is no room for UPC-A, and it is not
 * a truncation — it is a zero-suppression whose rule is chosen by the last
 * digit of the body. Most scanners expand it in firmware, but not all do, and a
 * studio should not have to know which theirs is.
 *
 * Returns null if the input is not a plausible UPC-E.
 */
export function expandUpcE(code: string): string | null {
  if (!/^[01][0-9]{7}$/.test(code)) return null

  const ns = code[0]
  const [d1, d2, d3, d4, d5, d6] = code.slice(1, 7)
  const check = code[7]

  let body: string
  if (d6 === '0' || d6 === '1' || d6 === '2') {
    body = `${ns}${d1}${d2}${d6}0000${d3}${d4}${d5}`
  } else if (d6 === '3') {
    body = `${ns}${d1}${d2}${d3}00000${d4}${d5}`
  } else if (d6 === '4') {
    body = `${ns}${d1}${d2}${d3}${d4}00000${d5}`
  } else {
    body = `${ns}${d1}${d2}${d3}${d4}${d5}0000${d6}`
  }

  // The compressed and expanded forms share a check digit; if they disagree
  // this was never a UPC-E.
  if (gtinCheckDigit(body) !== Number(check)) return null
  return `${body}${check}`
}

/**
 * Every rendering of the same GTIN that a scanner might hand us.
 *
 * GS1 defines a shorter GTIN as the longer one with leading zeros, so a
 * scanner set to UPC-A and one set to EAN-13 report the same product with a
 * digit's difference in length. Looking up only what was typed would make the
 * till's behaviour depend on a menu setting inside the scanner.
 */
export function barcodeVariants(raw: string): string[] {
  const digits = normalizeBarcode(raw)
  if (!digits) return []

  const out = new Set<string>([digits])
  const core = digits.replace(/^0+/, '')
  if (core.length > 0) {
    for (const width of [8, 12, 13, 14]) {
      if (core.length <= width) out.add(core.padStart(width, '0'))
    }
  }

  if (digits.length === 8) {
    const upcA = expandUpcE(digits)
    if (upcA) {
      out.add(upcA)
      out.add(`0${upcA}`)
    }
  }

  return [...out]
}

// ── Resolving a scan against the shelf ───────────────────────

/** The columns any surface needs to decide what a scan means. */
export type ScannableProduct = {
  id: number
  name: string
  barcode: string | null
  sku: string | null
  price_cents: number
  stock_qty: number
  unit: string
  is_active: boolean
  is_retail: boolean
  external_url: string | null
}

export type ScanResolution =
  /** Nothing on file carries that code. */
  | { kind: 'unknown'; code: string }
  /** Found, but it is back-bar or archived — not something a client buys. */
  | { kind: 'not_for_sale'; code: string; product: ScannableProduct }
  /** Found, but the studio has not set its price, so the till refuses it. */
  | { kind: 'unpriced'; code: string; product: ScannableProduct }
  /** Found and priced, but there is none on the shelf. */
  | { kind: 'out_of_stock'; code: string; product: ScannableProduct }
  | { kind: 'match'; code: string; product: ScannableProduct }

/** First product whose barcode is the same GTIN as `code`. */
export function matchProductByBarcode<T extends { barcode?: string | null }>(
  code: string,
  products: readonly T[]
): T | null {
  const wanted = new Set(barcodeVariants(code))
  if (wanted.size === 0) return null
  for (const p of products) {
    if (!p.barcode) continue
    if (barcodeVariants(p.barcode).some((v) => wanted.has(v))) return p
  }
  return null
}

/**
 * What a scan means at the counter.
 *
 * The order matters and is not arbitrary: a product with no price and no stock
 * should say "price it", because that is the thing standing between the studio
 * and selling it. Out of stock is answerable at the till — the brand's own
 * store will ship it — and an unpriced product is not.
 */
export function resolveScan(
  code: string,
  products: readonly ScannableProduct[]
): ScanResolution {
  const product = matchProductByBarcode(code, products)
  if (!product) return { kind: 'unknown', code }
  if (!product.is_active || !product.is_retail) return { kind: 'not_for_sale', code, product }
  if (product.price_cents <= 0) return { kind: 'unpriced', code, product }
  if (product.stock_qty <= 0) return { kind: 'out_of_stock', code, product }
  return { kind: 'match', code, product }
}
