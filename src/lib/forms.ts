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
 *
 * `formApplies` is that rule read forwards, from an appointment. The editors
 * read it backwards — a service asking what requires it, a category asking the
 * same of everything filed under it — and both of those live here rather than
 * in a component, because three screens now offer to change this targeting and
 * a second opinion about who a form reaches is how they would start disagreeing
 * with the booking flow.
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
 * The same question asked one level up: why is a form required across a whole
 * CATEGORY, and how much of it does that requirement actually cover?
 *
 * A category is a first-class targeting route — `category_ids` is an array the
 * booking flow reads directly — so a category editor may tick one on and off,
 * exactly as a service editor may tick `service_ids`. What it may NOT do is
 * pretend the four answers are two:
 *
 *   'studio'    both arrays empty, so every service in every category asks it.
 *               Not switchable from here for the same reason it is not
 *               switchable from one service: the only way to express "off for
 *               this category" would be to write every OTHER category's id in,
 *               silently changing what all of them require.
 *   'category'  this category's id is in `category_ids`. Ticked, and tickable.
 *   'services'  the form names individual services inside this category and not
 *               the category itself. It is required for SOME of what is filed
 *               here and not the rest. Rendering that as an unticked box would
 *               be a lie in both directions — it is not off, and ticking it
 *               would widen it to every service here rather than restore
 *               anything. It is shown with its count instead.
 *   null        no service filed here requires it.
 *
 * `covered` is what makes the third case legible, and it is exact: it is the
 * number of this category's services for which `formLinkForService` returns
 * non-null. That equality is the invariant tying this to the service side and
 * to `formApplies` — one implementation of "who asks for this", read from
 * whichever end the screen happens to be standing at.
 *
 * The one place `link` and `covered` come apart is an empty category: a form
 * targeting a category with nothing filed under it is 'category' with a
 * `covered` of 0. That is not a contradiction, it is targeting waiting for its
 * first service, and the tick has to stay on to say so.
 */
export type CategoryFormLink = 'studio' | 'category' | 'services' | null

export interface CategoryFormCoverage {
  link: CategoryFormLink
  /** Services filed here that require the form. */
  covered: number
  /** Services filed here at all, listed or not. */
  total: number
}

export function formLinkForCategory(
  form: FormTarget,
  /** null while a category is being created — nothing can be filed under it. */
  categoryId: number | null,
  /** Every service filed under this category, hidden ones included. */
  serviceIdsInCategory: readonly number[]
): CategoryFormCoverage {
  const services = form.service_ids ?? []
  const categories = form.category_ids ?? []
  const total = serviceIdsInCategory.length

  if (services.length === 0 && categories.length === 0) {
    return { link: 'studio', covered: total, total }
  }
  if (categoryId !== null && categories.includes(categoryId)) {
    return { link: 'category', covered: total, total }
  }

  const covered = serviceIdsInCategory.filter((id) => services.includes(id)).length
  return { link: covered > 0 ? 'services' : null, covered, total }
}

/**
 * Which of the four a category editor may offer as a checkbox.
 *
 * Both ends of one switch: 'category' is it ticked, null is it unticked. The
 * other two are states a tick cannot represent, so they are shown and not
 * offered — see the type's doc comment.
 */
export function categoryFormLinkIsTickable(link: CategoryFormLink): boolean {
  return link === 'category' || link === null
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
  return isTheLastTarget(form.service_ids, form.category_ids, serviceId)
}

/**
 * The same refusal from the category side, and it is the same failure.
 *
 * A form whose only target is this category, with no services of its own, has
 * one id standing between it and every client of the studio. Unticking it here
 * would empty both arrays, and empty means everyone — so the widest possible
 * change would be made from a screen about one category, by someone trying to
 * make the form apply to less.
 *
 * Shares its implementation with the service side deliberately: the rule is a
 * fact about the shape of `FormTarget`, not about which screen is asking, and
 * two copies of it would eventually disagree about which array counts.
 */
export function removingCategoryWouldTargetEveryone(
  form: FormTarget,
  categoryId: number
): boolean {
  return isTheLastTarget(form.category_ids, form.service_ids, categoryId)
}

/**
 * Is `id` the only thing keeping this form off everybody?
 *
 * `mine` is the array the id would come out of, `other` the array that would
 * still be holding the form down afterwards. `every` on an empty `mine` is
 * vacuously true, which is correct: a form already targeting nothing already
 * applies to everyone. Callers only ask about an id that is actually listed.
 */
function isTheLastTarget(
  mine: number[] | null,
  other: number[] | null,
  id: number
): boolean {
  if ((other ?? []).length > 0) return false
  return (mine ?? []).every((x) => x === id)
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
