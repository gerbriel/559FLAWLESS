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
 * Why a form is required for ONE service — `formApplies` asked from the other
 * side. The appointment asks "do I need this form?"; a service editor needs
 * "and where does that requirement come from?", because only one of the three
 * answers can be changed from a single service:
 *
 *   'studio'    both arrays empty, so everyone signs it. Switching it off for
 *               one service would mean writing every OTHER service's id into
 *               `service_ids`, silently changing what all of them require.
 *   'category'  this service's category is targeted. The same problem at the
 *               scale of a category.
 *   'service'   this service's id is in `service_ids`. This one, and only this
 *               one, a service editor may add and remove.
 *   null        not required.
 *
 * Category is reported ahead of service when both match, and that ordering is
 * the point: a form reached by category stays required however `service_ids` is
 * edited, so a tick offered there would be a control that does nothing.
 *
 * The invariant tying this to `formApplies`, for an appointment of one service:
 * `formLinkForService(f, id, cat) !== null` iff `formApplies(f, [id], [cat])`.
 * Break that and the editor starts describing requirements the booking flow
 * does not agree with.
 */
export type FormLink = 'studio' | 'category' | 'service' | null

export function formLinkForService(
  form: FormTarget,
  /** null while a service is being created — it has no id to be listed under. */
  serviceId: number | null,
  categoryId: number | null
): FormLink {
  const services = form.service_ids ?? []
  const categories = form.category_ids ?? []

  if (services.length === 0 && categories.length === 0) return 'studio'
  if (categoryId !== null && categories.includes(categoryId)) return 'category'
  if (serviceId !== null && services.includes(serviceId)) return 'service'
  return null
}

/** Inherited links are shown, never offered as a tick. */
export function formLinkIsInherited(link: FormLink): boolean {
  return link === 'studio' || link === 'category'
}

/**
 * Would taking this service off `service_ids` leave the form asked of EVERYONE?
 *
 * There is no way to write "nobody" in this shape. Both arrays empty is the
 * studio-wide case — `formApplies` returns true for every appointment — so
 * removing the last service id from a form with no categories is not a removal
 * at all. It is the widest change the data can express, made from a screen
 * about one service, and it silently changes what every OTHER service requires:
 * exactly the failure `formLinkForService` exists to prevent one step earlier.
 *
 * A service editor must refuse it and say so. Switching the form off, or
 * pointing it somewhere else, is a decision about the form and belongs on the
 * form's own page.
 */
export function removingServiceWouldTargetEveryone(
  form: FormTarget,
  serviceId: number
): boolean {
  if ((form.category_ids ?? []).length > 0) return false
  return (form.service_ids ?? []).every((id) => id === serviceId)
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
