/**
 * Which forms a given appointment actually requires.
 *
 * Both `consent_forms` and `intake_forms` carry `service_ids` and
 * `category_ids`. The rule they encode, in both tables:
 *
 *   either populated   → required when the appointment includes a matching
 *                        service, or a service in a matching category
 *   both arrays empty  → targeted at nothing, so required of nobody
 *
 * Untargeted applies to no one. That is the owner's rule and it is also what
 * the database has always done: migration 023's `appointment_outstanding_forms`
 * matches with `b.service_id = any (cf.service_ids)`, and `= any('{}')` is
 * false. This module read the same shape the opposite way for a week — the
 * staff screens called an untargeted form required of everyone while the
 * function that actually pulls forms into an appointment asked it of no one.
 * One of the two had to move, and it was this one.
 *
 * So there is no "asked of everybody" state to write here. A form that really
 * is meant for every client is expressed by naming every category, which is a
 * thing the form editors can do in one press, and which stays true rather than
 * quietly widening the moment somebody unticks the last box somewhere else.
 * The intimate-services consent must never be put in front of somebody booking
 * a brow wax; a general waiver has to say, in its own arrays, that it wants
 * everyone.
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

  // No special case for two empty arrays: `some` on an empty array is false,
  // which is the answer, and it is `= any('{}')` in 023 spelled in TypeScript.
  return (
    services.some((id) => serviceIds.includes(id)) ||
    categories.some((id) => categoryIds.includes(id))
  )
}

/**
 * Is this form pointed at nothing at all?
 *
 * Not a failure — emptying both arrays is the ordinary way to switch a form off
 * without deleting it or superseding a signed version. It is worth SAYING,
 * though, because the row looks configured: it has a title, wording, questions,
 * a re-sign interval, and it will never be asked of anybody. The Forms screens
 * flag it so it does not sit there looking live.
 */
export function formTargetsNothing(form: FormTarget): boolean {
  return (form.service_ids ?? []).length === 0 && (form.category_ids ?? []).length === 0
}

/**
 * The one sentence explaining what ticking nothing does, and the one flag for
 * a form that has ended up applying to nothing.
 *
 * They live next to the rule instead of in the two editors because the two
 * editors are exactly what went wrong: the intake editor promised "tick nothing
 * and every client is asked", the consent editor promised the opposite, and
 * only one of them could be right. Now neither writes the sentence itself.
 *
 * The hint says what to do instead, because the useful half of the old promise
 * was real — a studio does want one general waiver in front of everybody, and
 * the way to get it is to name every category. Both editors put that a press
 * away rather than leaving a manager to find eleven boxes.
 */
export const FORM_TARGETING_HINT =
  'Ticking nothing does not mean everyone: a form that names no category and no service applies to nothing and is never asked for automatically. To ask every client whatever they book, tick every category.'

/**
 * Deliberately about appointments, not about clients.
 *
 * "Nobody will ever be asked for it" would be a sentence this codebase cannot
 * keep: /account/forms lists every ACTIVE consent form for signing and consults
 * no targeting at all, so a client can still sign a form that applies to
 * nothing. What emptying the arrays really buys is the thing this module and
 * 023 both decide — no appointment pulls the form in. Say that, and leave
 * "switched off entirely" to the `is_active` tick, which is the control that
 * actually means it.
 */
export const FORM_APPLIES_TO_NOTHING =
  'This form applies to nothing, so no appointment will ever require it. Tick a category here, or name it on a service under Services, to put it back in front of clients.'

/**
 * Who a form reaches, in a phrase, for a list of templates.
 *
 * Both Forms screens print this and neither writes it, for the reason the whole
 * of this module exists in one file. The consent list said nothing about
 * targeting at all and the intake list said "asked of everyone" whenever no
 * CATEGORY was ticked — which was wrong twice over: wrong about the empty form,
 * and wrong about a form reaching services by name, which it called everyone.
 *
 * Categories are named because there are a handful of them and the name is the
 * useful fact. Services are counted because there can be forty and the count is
 * the useful fact; the service editor is where you go to see which.
 */
export function describeFormTargeting(
  form: FormTarget,
  categoryNames: ReadonlyMap<number, string>
): string {
  if (formTargetsNothing(form)) return 'applies to nothing'

  const named = (form.category_ids ?? [])
    .map((id) => categoryNames.get(id))
    .filter((name): name is string => !!name)
  const services = (form.service_ids ?? []).length

  const parts: string[] = []
  if (named.length > 0) parts.push(named.join(', '))
  // A category that has since been deleted or hidden leaves an id with no name.
  // Say the form is targeted rather than silently dropping to "applies to
  // nothing", which is the one answer that would be a lie here.
  else if ((form.category_ids ?? []).length > 0) parts.push('some categories')
  if (services > 0) parts.push(`${services} named ${services === 1 ? 'service' : 'services'}`)

  return `asked for ${parts.join(' · ')}`
}

/**
 * Why a form is required for ONE service — `formApplies` asked from the other
 * side. The appointment asks "do I need this form?"; a service editor needs
 * "and where does that requirement come from?", because only one of the answers
 * can be changed from a single service:
 *
 *   'category'  this service's category is targeted. Switching it off for one
 *               service would mean writing every OTHER service's id into
 *               `service_ids`, silently changing what all of them require.
 *   'service'   this service's id is in `service_ids`. This one, and only this
 *               one, a service editor may add and remove.
 *   null        not required — including the form that names nothing at all,
 *               which is required of nobody and so is not a state of its own.
 *
 * Category is reported ahead of service when both match, and that ordering is
 * the point: a form reached by category stays required however `service_ids` is
 * edited, so a tick offered there would be a control that does nothing.
 *
 * The invariant tying this to `formApplies`, for an appointment of one service:
 * `formLinkForService(f, id, cat) !== null` iff `formApplies(f, [id], [cat])`.
 * Break that and the editor starts describing requirements the booking flow
 * does not agree with. Both sides now answer "no" to the form that names
 * nothing; when they answered differently, this was the half that was wrong.
 */
export type FormLink = 'category' | 'service' | null

export function formLinkForService(
  form: FormTarget,
  /** null while a service is being created — it has no id to be listed under. */
  serviceId: number | null,
  categoryId: number | null
): FormLink {
  const services = form.service_ids ?? []
  const categories = form.category_ids ?? []

  if (categoryId !== null && categories.includes(categoryId)) return 'category'
  if (serviceId !== null && services.includes(serviceId)) return 'service'
  return null
}

/**
 * Inherited links are shown, never offered as a tick.
 *
 * One case now, not two: a form reached through this service's category. It
 * stays a named predicate rather than an inline `=== 'category'` because it is
 * the reason two screens agree about which rows get a checkbox.
 */
export function formLinkIsInherited(link: FormLink): boolean {
  return link === 'category'
}

/**
 * The same question asked one level up: why is a form required across a whole
 * CATEGORY, and how much of it does that requirement actually cover?
 *
 * A category is a first-class targeting route — `category_ids` is an array the
 * booking flow reads directly — so a category editor may tick one on and off,
 * exactly as a service editor may tick `service_ids`. What it may NOT do is
 * pretend the three answers are two:
 *
 *   'category'  this category's id is in `category_ids`. Ticked, and tickable.
 *   'services'  the form names individual services inside this category and not
 *               the category itself. It is required for SOME of what is filed
 *               here and not the rest. Rendering that as an unticked box would
 *               be a lie in both directions — it is not off, and ticking it
 *               would widen it to every service here rather than restore
 *               anything. It is shown with its count instead.
 *   null        no service filed here requires it — which is also the answer
 *               for a form that names nothing at all, since that form is
 *               required of nobody.
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
export type CategoryFormLink = 'category' | 'services' | null

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

  if (categoryId !== null && categories.includes(categoryId)) {
    return { link: 'category', covered: total, total }
  }

  const covered = serviceIdsInCategory.filter((id) => services.includes(id)).length
  return { link: covered > 0 ? 'services' : null, covered, total }
}

/**
 * Which of the three a category editor may offer as a checkbox.
 *
 * Both ends of one switch: 'category' is it ticked, null is it unticked. The
 * third is a state a tick cannot represent, so it is shown and not offered —
 * see the type's doc comment.
 *
 * Nothing here refuses an untick any more. Two guards used to live below this
 * line — `removingServiceWouldTargetEveryone` and its category twin — stopping
 * a manager from taking the last id out of a form's arrays, on the grounds that
 * empty meant everyone. Empty means nobody, so that is now the ordinary way to
 * switch a form off from either screen, and a refusal there would block a
 * legitimate action while explaining a rule that is no longer true.
 */
export function categoryFormLinkIsTickable(link: CategoryFormLink): boolean {
  return link === 'category' || link === null
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
