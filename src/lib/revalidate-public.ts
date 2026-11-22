/**
 * Ask the server to drop the cached copies of the public menu pages.
 *
 * The storefront is static and revalidates on a five-minute timer, which is
 * right for visitors and wrong for the manager who just moved a service or
 * ticked "best seller" and opens the page to check. This is the same seam the
 * inline edit kit uses (/api/admin/revalidate, manager only, fixed path list).
 *
 * Best effort on purpose: the write already succeeded, and if this call fails
 * the pages catch up on their own within minutes.
 */
export const MENU_PATHS = ['/', '/services'] as const

export function revalidatePublic(paths: readonly string[] = MENU_PATHS): Promise<void> {
  return fetch('/api/admin/revalidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  })
    .then(() => undefined)
    .catch(() => undefined)
}
