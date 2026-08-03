'use client'

import { Check, CircleHelp, Lightbulb } from 'lucide-react'
import { Select } from '@/components/ui/field'
import { Panel } from '@/components/ui/dashboard'
import type { CsvField } from '@/lib/csv/schema'
import { typeLabel } from '@/lib/csv/schema'
import type { ColumnProfile, MappingSuggestion } from '@/lib/csv/suggest'
import type { FieldMapping } from '@/lib/csv/prepare'

/**
 * Her columns beside our fields, with a guess already made and every guess
 * overridable.
 *
 * One row per field of ours rather than per column of hers, because the
 * question she is answering is "where does Date of Birth come from", not "what
 * is column 7 for". Fields she has nothing for stay blank and the required ones
 * say so.
 *
 * EVERY SUGGESTION SHOWS ITS REASONING. "The values look like email addresses"
 * and "the column is named Email" are different qualities of evidence, and she
 * can only tell a good guess from a lucky one if the screen says which it was.
 * A confident-looking dropdown with a silent wrong answer in it is the failure
 * this is designed against — it imports, it looks fine, and six months later
 * half the phone numbers are dates of birth.
 *
 * Under each dropdown are the first few values from the column she picked, so
 * the check is against the data itself and not against the header she is
 * already being shown.
 *
 * Stateless. The wizard owns the mapping; this renders it and reports changes.
 */
export function CsvColumnMapper({
  fields,
  headers,
  profiles,
  mapping,
  suggestions,
  alternatives,
  onChange,
}: {
  fields: readonly CsvField[]
  headers: readonly string[]
  profiles: readonly ColumnProfile[]
  mapping: FieldMapping
  suggestions: Record<string, MappingSuggestion | undefined>
  alternatives: Record<string, MappingSuggestion[]>
  onChange: (fieldKey: string, columnIndex: number | null) => void
}) {
  const columnName = (index: number) => headers[index]?.trim() || `Column ${index + 1}`
  const usedColumns = new Set(
    Object.values(mapping).filter((v): v is number => v !== null && v >= 0)
  )

  return (
    <div className="space-y-3">
      {fields.map((field) => {
        const chosen = mapping[field.key] ?? null
        const suggestion = suggestions[field.key]
        const isSuggested = suggestion !== undefined && suggestion.column === chosen
        const profile = chosen === null ? undefined : profiles[chosen]
        const others = alternatives[field.key] ?? []

        return (
          <Panel key={field.key} className="p-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{field.label}</span>
                  {field.required && (
                    <span className="label-caps text-[var(--color-accent)]">Required</span>
                  )}
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {typeLabel(field.type)} &middot; {field.description}
                </p>
              </div>

              <div className="min-w-0">
                <Select
                  aria-label={`Which of your columns holds ${field.label}`}
                  value={chosen === null ? '' : String(chosen)}
                  onChange={(event) =>
                    onChange(field.key, event.target.value === '' ? null : Number(event.target.value))
                  }
                >
                  <option value="">
                    {field.required ? '— required, choose a column —' : '— not in this file —'}
                  </option>
                  {headers.map((_, index) => (
                    <option key={index} value={index}>
                      {columnName(index)}
                      {usedColumns.has(index) && index !== chosen ? ' (already used)' : ''}
                    </option>
                  ))}
                </Select>

                {isSuggested && suggestion && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-[var(--color-muted)]">
                    <Lightbulb
                      className="mt-px h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]"
                      strokeWidth={1.5}
                      aria-hidden
                    />
                    <span>
                      <span className="text-[var(--color-foreground)]">
                        {suggestion.confidence === 'strong'
                          ? 'Suggested'
                          : suggestion.confidence === 'likely'
                            ? 'Probably'
                            : 'Best guess'}
                      </span>{' '}
                      &mdash; {suggestion.reason}. Change it if that is wrong.
                    </span>
                  </p>
                )}

                {!isSuggested && chosen !== null && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
                    <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
                    Your choice.
                  </p>
                )}

                {chosen === null && field.required && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-accent)]">
                    <CircleHelp className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
                    Nothing in this file looked like {field.label.toLowerCase()}.
                  </p>
                )}

                {profile && profile.samples.length > 0 && (
                  <p className="mt-2 truncate font-mono text-xs text-[var(--color-muted)]">
                    {profile.samples.slice(0, 3).join('  ·  ')}
                  </p>
                )}
                {profile && profile.samples.length === 0 && (
                  <p className="mt-2 text-xs text-[var(--color-muted)]">
                    That column is empty in every row.
                  </p>
                )}

                {isSuggested && others.length > 0 && (
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    Also considered {others.map((o) => `“${columnName(o.column)}”`).join(', ')}.
                  </p>
                )}
              </div>
            </div>
          </Panel>
        )
      })}
    </div>
  )
}
