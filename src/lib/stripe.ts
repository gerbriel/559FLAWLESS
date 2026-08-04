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
  const url = process.env.NEXT_PUBLIC_SITE_URL
  if (url) return url.replace(/\/$/, '')
  // The fallback is for local dev only. In production it would be worse than a
  // crash: Stripe Checkout sessions would be minted with success_url pointing
  // at localhost — the client pays and lands on a dead page — and admin reset
  // links would email a dead address. Fail the request loudly instead; the fix
  // is one env var.
  // Vercel names the deployment it is serving; not the custom domain, but a
  // live HTTPS address a client can land on, which localhost is not.
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXT_PUBLIC_SITE_URL is not set — refusing to build URLs that would point at localhost')
  }
  return 'http://localhost:3000'
}
