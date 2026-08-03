import { Panel } from '@/components/ui/dashboard'
import {
  formatHint,
  typeLabel,
  type CsvEntity,
} from '@/lib/csv/schema'

/**
 * What each column means, and whether it is required.
 *
 * Rendered from the entity definition, which is also what the template
 * download writes and what the importer reads. Nothing on this screen is
 * transcribed by hand, so it cannot drift out of step with the file it
 * describes — the usual failure of a documented format is that the
 * documentation and the parser are maintained separately and only one of them
 * gets updated.
 *
 * A server component: it has no state and nothing to handle, so it does not
 * drag a client boundary onto a page that is mostly prose.
 */
export function CsvSchemaTable({ entity }: { entity: CsvEntity }) {
  return (
    <div className="space-y-6">
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left">
              <th className="label-caps px-4 py-3 text-[var(--color-muted)]">Column</th>
              <th className="label-caps px-4 py-3 text-[var(--color-muted)]">Type</th>
              <th className="label-caps px-4 py-3 text-[var(--color-muted)]">Required</th>
              <th className="label-caps px-4 py-3 text-[var(--color-muted)]">What it is</th>
              <th className="label-caps px-4 py-3 text-[var(--color-muted)]">Example</th>
            </tr>
          </thead>
          <tbody>
            {entity.fields.map((field) => (
              <tr
                key={field.key}
                className="border-b border-[var(--color-border)] align-top last:border-b-0"
              >
                <td className="px-4 py-3">
                  <span className="font-medium">{field.label}</span>
                  {field.readOnly && (
                    <span className="label-caps mt-1 block text-[var(--color-muted)]">
                      Export only
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-[var(--color-muted)]">{typeLabel(field.type)}</td>
                <td className="px-4 py-3">
                  {field.readOnly ? (
                    <span className="text-[var(--color-muted)]">&mdash;</span>
                  ) : field.required ? (
                    <span className="text-[var(--color-accent)]">Required</span>
                  ) : (
                    <span className="text-[var(--color-muted)]">Optional</span>
                  )}
                </td>
                <td className="max-w-md px-4 py-3 text-[var(--color-muted)]">
                  {field.description}
                  {field.readOnly && field.readOnlyBecause && (
                    <span className="mt-1 block text-xs">{field.readOnlyBecause}</span>
                  )}
                  {!field.readOnly && (
                    <span className="mt-1 block text-xs">{formatHint(field)}</span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-[var(--color-muted)]">
                  {field.example || <span className="not-italic">(blank)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {entity.excluded.length > 0 && (
        <section>
          <h3 className="text-base">What is not here, and why</h3>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            A column missing without explanation looks like an oversight. None of
            these is.
          </p>
          <ul className="mt-4 space-y-3 text-sm">
            {entity.excluded.map((item) => (
              <li key={item.column} className="max-w-prose">
                <span className="text-[var(--color-foreground)]">{item.column}</span>
                <span className="mt-1 block text-[var(--color-muted)]">{item.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
