import 'server-only'
import Stripe from 'stripe'

let cached: Stripe | null = null

/**
 * Lazily constructed so a missing key is an error at the point of use rather
 * than at import time — the rest of the app has to keep working before Stripe
 * is configured.
 */
export function getStripe(): Stripe {
  if (cached) return cached
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set')
  cached = new Stripe(key)
  return cached
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
}
