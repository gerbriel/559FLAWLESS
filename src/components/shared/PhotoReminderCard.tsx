import { Camera, CameraOff, Clock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { ClientPhotoStatus, SignedTreatmentPhoto } from '@/types/clientprofile'

/**
 * The photo side of the client record: what consent covers, what has been
 * taken, and whether a progress photograph is overdue.
 *
 * Server-rendered on purpose — the images are addressed by short-lived signed
 * URLs minted server-side against a private bucket, and handing a client
 * component a storage path to sign for itself is how a private bucket stops
 * being private.
 *
 * `status.followup_due_at` is null whenever consent does not permit a
 * photograph, so the "time for a progress photo" line cannot appear for
 * somebody who never released, or who has withdrawn.
 */
export function PhotoReminderCard({
  status,
  photos,
  timeZone,
  now,
}: {
  status: ClientPhotoStatus | null
  photos: SignedTreatmentPhoto[]
  timeZone: string
  now: number
}) {
  const releaseOk = status?.photo_release_ok ?? false
  const withdrawn = Boolean(status?.photo_release_revoked_at)

  return (
    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h3 className="label-caps mb-5 flex items-center gap-2 text-[var(--color-accent)]">
        {releaseOk ? (
          <Camera className="h-3.5 w-3.5" strokeWidth={2} />
        ) : (
          <CameraOff className="h-3.5 w-3.5" strokeWidth={2} />
        )}
        Photographs
      </h3>

      {!releaseOk ? (
        <p className="text-sm text-[var(--color-muted)]">
          {withdrawn
            ? 'She has withdrawn the photo release. Nothing new is taken, and no reminder is raised — including the follow-ups.'
            : 'No photo release on file. She can give one herself under Account → Settings; until she does, none of the documentation prompts appear.'}
        </p>
      ) : (
        <>
          <p className="text-sm">
            {status!.documented_visits === 0 ? (
              <span className="text-[var(--color-muted)]">
                Nothing documented yet — no visit so far was for a service that is
                photographed.
              </span>
            ) : (
              <>
                {status!.documented_visits}{' '}
                {status!.documented_visits === 1 ? 'session' : 'sessions'},{' '}
                {status!.visits_with_photos} with photos
              </>
            )}
          </p>

          {status!.photo_count > 0 && (
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              {status!.before_count} before · {status!.after_count} after ·{' '}
              {status!.progress_count} progress
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Badge tone="success">Release on file</Badge>
            {status!.intimate_consent_ok && <Badge tone="info">Intimate photography consented</Badge>}
          </div>

          {status!.followup_due_at && (
            <div
              className={`mt-5 border-l-2 p-4 ${
                status!.followup_overdue
                  ? 'border-[var(--color-accent)] bg-[var(--color-clay-soft)] dark:bg-transparent'
                  : 'border-[var(--color-border)]'
              }`}
            >
              <p className="label-caps mb-2 flex items-center gap-2 text-[var(--color-muted)]">
                <Clock className="h-3.5 w-3.5" strokeWidth={2} />
                {status!.followup_overdue ? 'Progress photo due' : 'Next progress photo'}
              </p>
              <p className="text-sm">
                {status!.followup_overdue && status!.followup_visit_at
                  ? `It has been ${weeksSince(status!.followup_visit_at, now)} since ${status!.followup_service} — time for a progress photo.`
                  : `${status!.followup_service} · due ${shortDate(status!.followup_due_at, timeZone)}.`}
              </p>
            </div>
          )}
        </>
      )}

      {photos.length > 0 && (
        <div className="mt-6 border-t border-[var(--color-border)] pt-5">
          <h4 className="label-caps mb-3 text-xs text-[var(--color-muted)]">On file</h4>
          <ul className="grid grid-cols-3 gap-2">
            {photos.map((p) => (
              <li key={p.id} className="relative">
                {p.signedUrl ? (
                  // Not next/image: the URL is a signed one that expires in
                  // minutes, so there is nothing for the optimiser to cache and
                  // a stale entry would 403 in the browser.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.signedUrl}
                    alt={`${p.phase}${p.body_area ? ` · ${p.body_area}` : ''} · ${shortDate(p.taken_at, timeZone)}`}
                    className="aspect-square w-full object-cover"
                  />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center border border-[var(--color-border)]">
                    <CameraOff className="h-4 w-4 text-[var(--color-muted)]" strokeWidth={1.5} />
                  </div>
                )}
                <span className="label-caps mt-1 block text-[10px] text-[var(--color-muted)]">
                  {p.phase} · {shortDate(p.taken_at, timeZone)}
                </span>
                {p.deletion_requested_at && (
                  <span className="absolute inset-x-0 top-0 bg-red-700 px-1 py-0.5 text-center text-[10px] uppercase tracking-[0.12em] text-white">
                    Deleting
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            Private bucket. These links are signed for a few minutes and are not
            shareable.
          </p>
        </div>
      )}
    </section>
  )
}

function weeksSince(iso: string, now: number): string {
  const weeks = Math.max(1, Math.round((now - new Date(iso).getTime()) / (7 * 86_400_000)))
  return weeks === 1 ? 'a week' : `${weeks} weeks`
}

/** `locations.timezone` is authoritative for a site's wall clock. */
function shortDate(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}
