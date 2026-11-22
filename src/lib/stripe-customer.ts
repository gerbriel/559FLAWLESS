import 'server-only'
import type Stripe from 'stripe'
import type { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log-error'

type Admin = ReturnType<typeof createAdminClient>

export interface CustomerFor {
  /** The profile the customer belongs to. Always from the server's own reads, never a request body. */
  userId: string
  /** Used where the profile has none, and for the email-only fallback. */
  email?: string | null
  name?: string | null
  phone?: string | null
}

/**
 * One Stripe customer per signed-in client (091).
 *
 * Made the first time they pay anything and reused on every later session,
 * so Stripe shows one customer with the whole history, a card can be saved,
 * and promotion codes bound to a customer can be redeemed. The id lives on
 * profiles.stripe_customer_id, which only the service role may write; an id
 * from the browser is never trusted, because none is ever read from one.
 *
 * Concurrency: the create carries an idempotency key per client, so two
 * requests racing here within Stripe's idempotency window get the same
 * customer back. The profile write is a compare-and-set on a null column, so
 * whichever writer lands first wins and the other adopts its id; a customer
 * made by the loser that is not the stored one is deleted at Stripe so no
 * orphan is left behind.
 *
 * Throws when Stripe or the database fails. Call sites that would rather fall
 * back to an email-only session use checkoutCustomer() below.
 */
export async function ensureStripeCustomer(
  admin: Admin,
  stripe: Stripe,
  who: CustomerFor
): Promise<string> {
  const { data: profile, error: readError } = await admin
    .from('profiles')
    .select('stripe_customer_id, email, first_name, last_name, phone')
    .eq('id', who.userId)
    .maybeSingle()
  if (readError) throw new Error(`read profile customer: ${readError.message}`)
  if (!profile) throw new Error('no profile for that client')

  let replacing: string | null = null
  if (profile.stripe_customer_id) {
    const live = await customerIsLive(stripe, profile.stripe_customer_id)
    if (live) return profile.stripe_customer_id
    // Deleted at Stripe (or never in this Stripe account). Let go of it, but
    // only if it is still the stored one: a concurrent writer may have
    // replaced it already.
    replacing = profile.stripe_customer_id
    const { error: clearError } = await admin
      .from('profiles')
      .update({ stripe_customer_id: null })
      .eq('id', who.userId)
      .eq('stripe_customer_id', replacing)
    if (clearError) throw new Error(`clear dead customer: ${clearError.message}`)
  }

  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim()
  // The account's own details first; what the caller knows fills the gaps.
  const email = profile.email?.trim() || who.email?.trim() || undefined
  const name = fullName || who.name?.trim() || undefined
  const phone = profile.phone?.trim() || who.phone?.trim() || undefined

  let created: Stripe.Customer
  try {
    created = await stripe.customers.create(
      { email, name, phone, metadata: { client_id: who.userId } },
      // A replacement gets its own key: within the idempotency window the first
      // key would hand back the very customer that was deleted.
      { idempotencyKey: replacing ? `customer:${who.userId}:after:${replacing}` : `customer:${who.userId}` }
    )
  } catch (err) {
    // A concurrent request holds the same key (still in flight), or sent it
    // with different details. Its customer is the one that will be stored:
    // give it a moment, then take whatever the profile holds. Nothing there
    // means the caller falls back to an email-only session.
    if (!isIdempotencyError(err)) throw err
    await new Promise((resolve) => setTimeout(resolve, 750))
    const { data: after } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', who.userId)
      .maybeSingle()
    if (after?.stripe_customer_id && after.stripe_customer_id !== replacing) return after.stripe_customer_id
    throw err
  }

  const { data: written, error: writeError } = await admin
    .from('profiles')
    .update({ stripe_customer_id: created.id })
    .eq('id', who.userId)
    .is('stripe_customer_id', null)
    .select('id')
  // Not deleted on a failed write: under the shared idempotency key this may
  // be the very customer a concurrent request has just stored.
  if (writeError) throw new Error(`store customer: ${writeError.message}`)
  if (written && written.length > 0) return created.id

  // Somebody else stored one first. Theirs stands.
  const { data: again, error: rereadError } = await admin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', who.userId)
    .maybeSingle()
  if (rereadError) throw new Error(`re-read profile customer: ${rereadError.message}`)
  const stored = again?.stripe_customer_id ?? null
  if (!stored) throw new Error('customer was not stored and none is on the profile')
  if (stored !== created.id) await dropOrphan(stripe, created.id, who.userId)
  return stored
}

/**
 * The customer half of a Checkout Session for a signed-in client: `customer`
 * plus the offer to save the card, or, if the customer cannot be had right
 * now, the email-only session the client would have had before 091. A glitch
 * at Stripe's customer API should not stop anyone paying.
 */
export async function checkoutCustomer(
  admin: Admin,
  stripe: Stripe,
  who: CustomerFor,
  mode: 'payment' | 'subscription' = 'payment'
): Promise<
  | {
      customerId: string
      params: Pick<Stripe.Checkout.SessionCreateParams, 'customer' | 'saved_payment_method_options'>
    }
  | { customerId: null; params: Pick<Stripe.Checkout.SessionCreateParams, 'customer_email'> }
> {
  try {
    const customerId = await ensureStripeCustomer(admin, stripe, who)
    return {
      customerId,
      params: {
        customer: customerId,
        // A subscription keeps its card anyway; the offer is for one-off payments.
        ...(mode === 'payment' ? { saved_payment_method_options: { payment_method_save: 'enabled' as const } } : {}),
      },
    }
  } catch (err) {
    void logError('stripe/customer', err, { client_id: who.userId })
    return { customerId: null, params: { customer_email: who.email?.trim() || undefined } }
  }
}

function isIdempotencyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  // The SDK's error class names itself in `type` and keeps Stripe's own
  // `type` as `rawType`; both are read so a plain error object works too.
  const e = err as { type?: unknown; rawType?: unknown; code?: unknown }
  return (
    e.rawType === 'idempotency_error' ||
    e.type === 'idempotency_error' ||
    e.type === 'StripeIdempotencyError' ||
    e.code === 'idempotency_key_in_use'
  )
}

async function customerIsLive(stripe: Stripe, id: string): Promise<boolean> {
  try {
    const customer = await stripe.customers.retrieve(id)
    return !('deleted' in customer && customer.deleted)
  } catch (err) {
    if ((err as { code?: string }).code === 'resource_missing') return false
    throw err
  }
}

async function dropOrphan(stripe: Stripe, id: string, userId: string): Promise<void> {
  try {
    await stripe.customers.del(id)
  } catch (err) {
    void logError('stripe/customer', err, { step: 'delete_orphan', customer: id, client_id: userId })
  }
}
