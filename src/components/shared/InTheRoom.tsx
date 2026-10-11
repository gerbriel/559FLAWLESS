import Image from 'next/image'

/** One silent loop: its file stem under /public/video, and what it shows. */
const CLIPS = [
  {
    stem: 'room-facial',
    label: 'Corrective facial',
    alt: 'Hands working a treatment into the skin during a facial',
  },
  {
    stem: 'room-mask',
    label: 'Mixed fresh, per client',
    alt: 'A mask being mixed in a glass bowl',
  },
  {
    stem: 'room-wax',
    label: 'Hard wax',
    alt: 'Hard wax being stirred in the warmer',
  },
] as const

/**
 * Three short, silent loops from the treatment room.
 *
 * The <video> tag is written as a raw string on purpose. React does not put
 * the `muted` attribute into server-rendered HTML — it sets the property on
 * hydration — and Safari and Chrome decide whether a video may autoplay from
 * the attributes present when the tag is PARSED. A React-rendered
 * `<video muted autoPlay>` is therefore a video that never starts on an
 * iPhone. Raw markup is the one way to guarantee the attribute is there.
 * Nothing in the string comes from a request: three file stems and three alt
 * strings from the list above.
 *
 * The files are 360×360, ~300KB, encoded with NO audio stream at all — there
 * is nothing to unmute, and the originals with sound were never added to the
 * repo. Under prefers-reduced-motion the video is hidden and the poster frame
 * shows in its place.
 */
export function InTheRoom() {
  return (
    <ul className="grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3">
      {CLIPS.map((c) => (
        <li key={c.stem} className="bg-[var(--color-background)]">
          <div className="relative aspect-square w-full overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-surface)]">
            <div
              className="absolute inset-0 motion-reduce:hidden"
              dangerouslySetInnerHTML={{ __html: videoMarkup(c.stem, c.alt) }}
            />
            <Image
              src={`/video/${c.stem}.jpg`}
              alt={c.alt}
              fill
              sizes="(max-width: 640px) 100vw, 33vw"
              className="hidden object-cover motion-reduce:block"
            />
          </div>
          <p className="label-caps p-5 text-[var(--color-muted)]">{c.label}</p>
        </li>
      ))}
    </ul>
  )
}

function videoMarkup(stem: string, alt: string): string {
  return (
    `<video class="h-full w-full object-cover" autoplay muted loop playsinline ` +
    `preload="metadata" poster="/video/${stem}.jpg" aria-label="${alt}" ` +
    `disablepictureinpicture disableremoteplayback>` +
    `<source src="/video/${stem}.mp4" type="video/mp4"></video>`
  )
}
