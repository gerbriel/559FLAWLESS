import * as React from 'react'

/**
 * Renders a legal document held as Markdown in `site_settings`.
 *
 * The terms and the privacy policy are the two pieces of copy on this site an
 * admin edits directly, and they were being rendered by regex — `## ` became a
 * `<h2>` with nothing to close it, and every newline became a `<br />`, so no
 * paragraph ever formed and `prose` had nothing to style. Long documents came
 * out as one run-on column of text under a stack of nested headings.
 *
 * This parses the small subset those documents actually use and returns real
 * elements. It also gets us off `dangerouslySetInnerHTML`: the content is
 * admin-authored rather than public, but a legal page is a poor place to keep
 * an HTML injection point alive for no reason.
 */

/** `**bold**` — the only inline mark these documents use. */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <strong key={`${keyPrefix}-${i}`} className="font-medium text-[var(--color-foreground)]">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <React.Fragment key={`${keyPrefix}-${i}`}>{part}</React.Fragment>
    )
  )
}

export function LegalDocument({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []

  // Consecutive `- ` lines are one list, and consecutive plain lines are one
  // paragraph — a blank line, a heading or a bullet closes whatever is open.
  let paragraph: string[] = []
  let bullets: string[] = []

  const flush = () => {
    if (paragraph.length > 0) {
      const key = `p-${blocks.length}`
      blocks.push(<p key={key}>{inline(paragraph.join(' '), key)}</p>)
      paragraph = []
    }
    if (bullets.length > 0) {
      const key = `ul-${blocks.length}`
      blocks.push(
        <ul key={key}>
          {bullets.map((item, i) => (
            <li key={`${key}-${i}`}>{inline(item, `${key}-${i}`)}</li>
          ))}
        </ul>
      )
      bullets = []
    }
  }

  for (const raw of lines) {
    const line = raw.trim()

    if (line === '') {
      flush()
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const key = `h-${blocks.length}`
      const text = inline(heading[2], key)
      // A document that carries its own title would otherwise render an <h1>
      // under the page's own — same level, twice. Everything shifts down one.
      if (heading[1].length === 1) blocks.push(<h2 key={key}>{text}</h2>)
      else if (heading[1].length === 2) blocks.push(<h3 key={key}>{text}</h3>)
      else blocks.push(<h4 key={key}>{text}</h4>)
      continue
    }

    if (line.startsWith('- ')) {
      if (paragraph.length > 0) flush()
      bullets.push(line.slice(2))
      continue
    }

    if (bullets.length > 0) flush()
    paragraph.push(line)
  }

  flush()

  return <div className="prose prose-neutral max-w-3xl dark:prose-invert">{blocks}</div>
}
