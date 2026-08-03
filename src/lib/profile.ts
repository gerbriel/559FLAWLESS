/**
 * What an account is made of.
 *
 * First name, last name, email and phone are what the studio asks for at the
 * desk, so they are what an account carries — and a date of birth besides,
 * because several services have an age minimum and asking at the appointment is
 * asking too late.
 *
 * Email is absent from the check on purpose: an account cannot exist without
 * one. It is what the person signed in with to get to the page doing the
 * checking.
 *
 * This lived in three places — the OAuth callback, the booking page, and the
 * completion gate itself — each written separately and each slightly different
 * from the others. Three copies of a rule are three chances for someone to slip
 * past the two that were not updated, which is exactly what happened when last
 * name joined the list. One predicate, three callers.
 */
export interface ProfileCompleteness {
  first_name: string | null
  last_name: string | null
  phone: string | null
  date_of_birth: string | null
}

/** The fields still owed, in the order a form would ask for them. */
export function missingProfileFields(profile: ProfileCompleteness | null): string[] {
  if (!profile) return ['first name', 'last name', 'phone number', 'date of birth']

  const missing: string[] = []
  if (!profile.first_name?.trim()) missing.push('first name')
  if (!profile.last_name?.trim()) missing.push('last name')
  if (!profile.phone?.trim()) missing.push('phone number')
  if (!profile.date_of_birth) missing.push('date of birth')
  return missing
}

export function isProfileComplete(profile: ProfileCompleteness | null): boolean {
  return missingProfileFields(profile).length === 0
}
