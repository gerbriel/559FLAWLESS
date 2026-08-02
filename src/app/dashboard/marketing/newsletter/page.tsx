import { redirect } from 'next/navigation'

/**
 * Retired. The subscriber list lives at /dashboard/clients/newsletter.
 *
 * This page read `newsletter_subscriptions`, which migration 022 superseded.
 * The public signup form writes to `newsletter_subscribers`; 022 folded
 * everything from the old table into it and left a comment on the table saying
 * outright that "nothing reads it for day-to-day work" — it is retained only
 * for the consent evidence (IP and user agent) it holds.
 *
 * 022 also names the exact bug this page was half of: "a signup landing in one
 * and the studio looking at the other is precisely why submissions appeared to
 * go nowhere." Every signup since that migration is invisible here. So this URL
 * is not an orphan waiting to be re-advertised with a tab — giving it one would
 * hand managers a stale, shrinking count sitting one tab away from the Overview
 * tile that counts the live table, and would re-stage the failure 022 fixed.
 * Forwarding to the list that is actually maintained is the fix; that also
 * clears the no-tab-highlighted state, since this URL no longer renders inside
 * the Marketing section at all.
 *
 * Kept as a redirect rather than deleted so existing bookmarks land somewhere
 * useful instead of on a 404.
 *
 * The gate is the target's: /dashboard/clients/newsletter requires
 * `isFrontDesk`, which every `isManager` viewer of this section already
 * satisfies, so the hop cannot eject anyone who could open this URL. Nothing is
 * read here, so there is nothing to leak ahead of the redirect.
 */
export default function RetiredMarketingNewsletterPage() {
  redirect('/dashboard/clients/newsletter')
}
