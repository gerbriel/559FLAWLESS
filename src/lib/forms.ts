/**
 * Which forms a given appointment actually requires.
 *
 * Both `consent_forms` and `intake_forms` carry `service_ids` and
 * `category_ids`. The rule they encode, in both tables:
 *
 *   both arrays empty  → studio-wide; everyone signs it
 *   either populated   → only when the appointment includes a matching
 *                        service, or a service in a matching category
 *
 * That distinction matters: the intimate-services consent must never be put in
 * front of somebody booking a brow wax, and a studio-wide liability waiver must
 * never be missed because nobody remembered to tick every category.
 */

export interface FormTarget {
  service_ids: number[] | null
  category_ids: number[] | null
}

/** Does this template apply to an appointment covering these services? */
export function formApplies(
  form: FormTarget,
  serviceIds: readonly number[],
  categoryIds: readonly number[]
): boolean {
  const services = form.service_ids ?? []
  const categories = form.category_ids ?? []

  // Untargeted means everybody — not nobody.
  if (services.length === 0 && categories.length === 0) return true

  return (
    services.some((id) => serviceIds.includes(id)) ||
    categories.some((id) => categoryIds.includes(id))
  )
}

/**
 * A signature that has passed its expiry no longer counts.
 *
 * Consent is an attestation about a body at a point in time — "no, I am not
 * taking isotretinoin" is true until it isn't. `revalidate_after_days` is what
 * turns that into an expiry, and honouring it is the whole reason the column
 * exists.
 */
export function signatureIsCurrent(
  signature: { expires_at: string | null },
  now: number
): boolean {
  return !signature.expires_at || new Date(signature.expires_at).getTime() > now
}

/** How intake staleness is judged everywhere: a health history over a year old. */
export const INTAKE_MAX_AGE_MS = 365 * 86_400_000

export function intakeIsCurrent(
  submission: { submitted_at: string } | null | undefined,
  now: number
): boolean {
  if (!submission) return false
  return new Date(submission.submitted_at).getTime() > now - INTAKE_MAX_AGE_MS
}
