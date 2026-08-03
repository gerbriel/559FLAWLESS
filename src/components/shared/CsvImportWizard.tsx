'use client'

import * as React from 'react'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileUp,
  Loader2,
  RotateCcw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Panel, StatTile } from '@/components/ui/dashboard'
import { FilterPills } from '@/components/ui/dashboard-client'
import { CsvColumnMapper } from '@/components/shared/CsvColumnMapper'
import { parseCsv, delimiterLabel } from '@/lib/csv/parse'
import {
  headersLookLikeData,
  suggestMapping,
  type ColumnProfile,
  type MappingSuggestion,
} from '@/lib/csv/suggest'
import { importableFields, type CsvEntity, type CsvEntityKey } from '@/lib/csv/schema'
import type { FieldMapping } from '@/lib/csv/prepare'
import {
  LIMIT_MESSAGES,
  MAX_FILE_BYTES,
  MAX_IMPORT_ROWS,
  PARSE_ROW_CEILING,
} from '@/lib/csv/limits'

/**
 * Choose a file, say what its columns are, look at what would happen, then say
 * go.
 *
 * The order is the point. Nothing is written until she has seen the numbers —
 * created, updated, added as contacts, rejected — and the reasons behind the
 * last one. Those numbers come from the server running the real import with the
 * writes left out, not from an estimate made here, and the commit re-derives
 * them from the same rows rather than being told what the preview concluded.
 *
 * "Added as contacts" only ever appears on a client import and only when there
 * are any. It counts the people with no email address, who become a contact the
 * studio has to invite rather than an account that already exists — a number
 * she needs before she commits, not after.
 *
 * The file is parsed IN THE BROWSER, before anything is uploaded. That is what
 * makes the mapping screen instant, and it means a file she opens by mistake
 * never leaves the laptop. The rows are sent when she asks for the preview and
 * again when she commits — the same rows both times, so the server can reach
 * the same conclusion twice.
 *
 * No effects. Every state change here hangs off something she did, which keeps
 * the React Compiler's rules satisfied for free and, more usefully, means there
 * is no moment where the screen is doing something she did not ask for.
 */

type Problem = { message: string; column: string | null; count: number; lines: number[] }

/**
 * A client with no email address is not an account and cannot be made into one
 * — see migration 051 and `RowTarget` in lib/csv/apply.ts. They are a contact:
 * somebody the studio knows and has not signed up yet. The two are counted
 * apart here for the same reason they are counted apart on the server, which is
 * that "forty new clients" and "forty new clients, twelve of whom you still
 * have to invite" are different sentences.
 */
type RowTarget = 'record' | 'contact'

type PreviewResponse = {
  create: number
  update: number
  createContact: number
  updateContact: number
  reject: number
  matchRule: string | null
  onNoMatch: string | null
  sample: {
    line: number
    action: 'create' | 'update'
    target: RowTarget
    label: string
    matchedBy: string | null
    existing: string | null
  }[]
  problems: Problem[]
  ignoredColumns: string[]
  unmappedFields: { key: string; label: string; required: boolean }[]
  notes: string[]
}

type CommitResponse = {
  created: number
  updated: number
  contactsCreated: number
  contactsUpdated: number
  /** Stamped on every contact this run added, so the batch can be found again. */
  importBatch: string | null
  failed: number
  rejected: number
  failures: { line: number; label: string; message: string }[]
}

type LoadedFile = {
  name: string
  headers: string[]
  rows: string[][]
  delimiter: string
  ragged: number
  truncated: boolean
  /** Header cells that read as data, i.e. the file may have no header row. */
  dataInHeader: string[]
}

export function CsvImportWizard({ entities }: { entities: CsvEntity[] }) {
  const importable = entities.filter((entity) => entity.importing !== null)

  const [entityKey, setEntityKey] = React.useState<CsvEntityKey | ''>(importable[0]?.key ?? '')
  const [file, setFile] = React.useState<LoadedFile | null>(null)
  const [mapping, setMapping] = React.useState<FieldMapping>({})
  const [suggestions, setSuggestions] = React.useState<Record<string, MappingSuggestion | undefined>>({})
  const [alternatives, setAlternatives] = React.useState<Record<string, MappingSuggestion[]>>({})
  const [profiles, setProfiles] = React.useState<ColumnProfile[]>([])
  const [preview, setPreview] = React.useState<PreviewResponse | null>(null)
  const [result, setResult] = React.useState<CommitResponse | null>(null)
  const [busy, setBusy] = React.useState<'preview' | 'commit' | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const entity = entities.find((e) => e.key === entityKey)
  const fields = entity ? importableFields(entity) : []
  const inputRef = React.useRef<HTMLInputElement>(null)

  const reset = () => {
    setFile(null)
    setMapping({})
    setSuggestions({})
    setAlternatives({})
    setProfiles([])
    setPreview(null)
    setResult(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  // FilterPills speaks in strings; the entity list is the allow-list that turns
  // one back into a key.
  const chooseEntity = (key: string) => {
    const found = importable.find((e) => e.key === key)
    if (!found) return
    setEntityKey(found.key)
    reset()
  }

  const onFileChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0]
    if (!chosen || !entity) return

    reset()

    if (chosen.size > MAX_FILE_BYTES) {
      setError(LIMIT_MESSAGES.fileTooLarge)
      return
    }

    const text = await chosen.text()
    const parsed = parseCsv(text, { maxDataRows: PARSE_ROW_CEILING })

    if (parsed.headers.length === 0) {
      setError(LIMIT_MESSAGES.noHeaders)
      return
    }
    if (parsed.rows.length === 0) {
      setError(LIMIT_MESSAGES.empty)
      return
    }

    const guess = suggestMapping(parsed.headers, parsed.rows, importableFields(entity))
    const initial: FieldMapping = {}
    for (const field of importableFields(entity)) {
      initial[field.key] = guess.chosen[field.key]?.column ?? null
    }

    setFile({
      name: chosen.name,
      headers: parsed.headers,
      rows: parsed.rows,
      delimiter: delimiterLabel(parsed.delimiter),
      ragged: parsed.ragged,
      truncated: parsed.truncated,
      dataInHeader: headersLookLikeData(parsed.headers),
    })
    setMapping(initial)
    setSuggestions(guess.chosen)
    setAlternatives(guess.alternatives)
    setProfiles(guess.profiles)
  }

  // Changing the mapping invalidates the plan she was shown. Dropping it is the
  // honest move: a preview that does not match the mapping beneath it is worse
  // than no preview.
  const changeMapping = (fieldKey: string, columnIndex: number | null) => {
    setMapping((current) => ({ ...current, [fieldKey]: columnIndex }))
    setPreview(null)
    setResult(null)
  }

  const send = async (path: string): Promise<Response | null> => {
    if (!entity || !file) return null
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: entity.key,
        headers: file.headers,
        rows: file.rows,
        mapping,
      }),
    })
  }

  const runPreview = async () => {
    setBusy('preview')
    setError(null)
    setResult(null)
    try {
      const response = await send('/api/data/import/preview')
      const body = await response?.json().catch(() => null)
      if (!response?.ok) {
        setError(body?.message ?? 'That could not be checked. Nothing was written.')
        return
      }
      setPreview(body as PreviewResponse)
    } finally {
      setBusy(null)
    }
  }

  const runCommit = async () => {
    setBusy('commit')
    setError(null)
    try {
      const response = await send('/api/data/import/commit')
      const body = await response?.json().catch(() => null)
      if (!response?.ok) {
        setError(body?.message ?? 'The import did not finish.')
        return
      }
      setResult(body as CommitResponse)
      setPreview(null)
    } finally {
      setBusy(null)
    }
  }

  const tooManyRows = (file?.rows.length ?? 0) > MAX_IMPORT_ROWS
  const missingRequired = fields.filter((f) => f.required && (mapping[f.key] ?? null) === null)

  if (importable.length === 0) return null

  return (
    <div className="space-y-8">
      <div>
        <p className="label-caps mb-3 text-[var(--color-muted)]">1. What are you importing</p>
        <FilterPills
          label="What are you importing"
          value={entityKey}
          onChange={chooseEntity}
          options={importable.map((e) => ({ value: e.key, label: e.label }))}
        />
      </div>

      {entity?.importing && (
        <Panel className="p-5">
          <h3 className="text-base">How a row is matched to what is already here</h3>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            {entity.importing.matchRule}
          </p>
          <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
            {entity.importing.onNoMatch}
          </p>
          <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
            An empty cell means <span className="text-[var(--color-foreground)]">leave that
            alone</span>, never <span className="text-[var(--color-foreground)]">clear it</span>.
            A file with gaps in it fills in what it knows and touches nothing else.
          </p>
        </Panel>
      )}

      <div>
        <p className="label-caps mb-3 text-[var(--color-muted)]">2. Choose the file</p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={onFileChosen}
            className="block w-full max-w-md text-sm text-[var(--color-muted)] file:mr-4 file:cursor-pointer file:border file:border-[var(--color-border)] file:bg-[var(--color-surface)] file:px-4 file:py-2.5 file:text-sm file:text-[var(--color-foreground)] hover:file:border-[var(--color-accent)]"
          />
          {file && (
            <Button type="button" variant="ghost" size="sm" onClick={reset}>
              <RotateCcw className="h-4 w-4" strokeWidth={1.5} aria-hidden />
              Start over
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Read on this computer first — nothing is uploaded until you ask for the
          check. Up to {Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB and{' '}
          {MAX_IMPORT_ROWS.toLocaleString('en-US')} rows.
        </p>
      </div>

      {error && (
        <Panel className="border-[var(--color-accent)] p-5">
          <p className="flex items-start gap-2 text-sm">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]"
              strokeWidth={1.5}
              aria-hidden
            />
            <span>{error}</span>
          </p>
        </Panel>
      )}

      {file && entity && (
        <>
          <Panel className="p-5">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <FileUp className="h-4 w-4 text-[var(--color-muted)]" strokeWidth={1.5} aria-hidden />
              <span className="font-medium">{file.name}</span>
              <span className="text-[var(--color-muted)]">
                &mdash; {file.rows.length.toLocaleString('en-US')} rows,{' '}
                {file.headers.length} columns, {file.delimiter}-separated
              </span>
            </p>
            {file.dataInHeader.length > 0 && (
              <p className="mt-2 text-xs text-[var(--color-accent)]">
                The top row of this file reads like a record rather than column
                names ({file.dataInHeader.slice(0, 3).join(', ')}). The first row
                is always taken as the header, so if this file was saved without
                one, that record is not in the {file.rows.length.toLocaleString('en-US')}{' '}
                counted above and will not be imported. Add a header row and
                choose the file again.
              </p>
            )}
            {file.ragged > 0 && (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                {file.ragged} {file.ragged === 1 ? 'row has' : 'rows have'} a different
                number of cells than the header. Short rows are padded, long rows are
                clipped — worth a look before you commit.
              </p>
            )}
            {file.truncated && (
              <p className="mt-2 text-xs text-[var(--color-accent)]">
                Only the first {PARSE_ROW_CEILING.toLocaleString('en-US')} rows were read.
              </p>
            )}
            {tooManyRows && (
              <p className="mt-2 text-xs text-[var(--color-accent)]">{LIMIT_MESSAGES.tooManyRows}</p>
            )}
          </Panel>

          <div>
            <p className="label-caps mb-3 text-[var(--color-muted)]">3. Map the columns</p>
            <p className="mb-4 max-w-prose text-sm text-[var(--color-muted)]">
              Each guess below was made from the column&rsquo;s name and from what is
              actually in it, and it says which. Change anything that looks wrong —
              nothing here is decided until you press the button at the bottom.
            </p>
            <CsvColumnMapper
              fields={fields}
              headers={file.headers}
              profiles={profiles}
              mapping={mapping}
              suggestions={suggestions}
              alternatives={alternatives}
              onChange={changeMapping}
            />
          </div>

          <div>
            <p className="label-caps mb-3 text-[var(--color-muted)]">4. Check before writing</p>
            {missingRequired.length > 0 && (
              <p className="mb-3 text-sm text-[var(--color-accent)]">
                Still needed: {missingRequired.map((f) => f.label).join(', ')}. Every row
                will be rejected without {missingRequired.length === 1 ? 'it' : 'them'}.
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={runPreview}
              disabled={busy !== null || tooManyRows}
            >
              {busy === 'preview' ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} aria-hidden />
              ) : (
                <ArrowRight className="h-4 w-4" strokeWidth={1.5} aria-hidden />
              )}
              Check what this would do
            </Button>
          </div>
        </>
      )}

      {preview && entity && (
        <PreviewPanel
          preview={preview}
          entity={entity}
          busy={busy === 'commit'}
          onCommit={runCommit}
        />
      )}

      {result && <ResultPanel result={result} onReset={reset} />}
    </div>
  )
}

/* ── The preview ──────────────────────────────────────────── */

function PreviewPanel({
  preview,
  entity,
  busy,
  onCommit,
}: {
  preview: PreviewResponse
  entity: CsvEntity
  busy: boolean
  onCommit: () => void
}) {
  const contacts = preview.createContact + preview.updateContact
  const willWrite = preview.create + preview.update + contacts

  return (
    <div className="space-y-5">
      <div className={contacts > 0 ? 'grid gap-3 sm:grid-cols-2 lg:grid-cols-4' : 'grid gap-3 sm:grid-cols-3'}>
        <StatTile
          label="Would be created"
          value={preview.create.toLocaleString('en-US')}
          hint={entity.key === 'clients' ? 'With an account they can log in to' : undefined}
        />
        <StatTile
          label="Would be updated"
          value={preview.update.toLocaleString('en-US')}
          hint="Already here, matched"
        />
        {/*
          Only when there are any, and never folded into "created". The whole
          point of the number is that these are the people the studio will have
          to invite one by one later, and a total that hides them inside the
          accounts answers the wrong question.
        */}
        {contacts > 0 && (
          <StatTile
            label="Added as contacts"
            value={contacts.toLocaleString('en-US')}
            hint={`No email address, so no account yet — ${preview.createContact.toLocaleString('en-US')} new, ${preview.updateContact.toLocaleString('en-US')} already on the list`}
          />
        )}
        <StatTile
          label="Would be rejected"
          value={preview.reject.toLocaleString('en-US')}
          hint={preview.reject > 0 ? 'Never written — reasons below' : 'Nothing wrong'}
        />
      </div>

      {preview.unmappedFields.length > 0 && (
        <Panel className="p-5">
          <h3 className="text-base">Fields with no column behind them</h3>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            {preview.unmappedFields.map((f) => f.label).join(', ')}. On an existing
            record these are left exactly as they are.
          </p>
        </Panel>
      )}

      {preview.ignoredColumns.length > 0 && (
        <Panel className="p-5">
          <h3 className="text-base">Columns in your file that will be ignored</h3>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            {preview.ignoredColumns.join(', ')}. Nothing is read from{' '}
            {preview.ignoredColumns.length === 1 ? 'it' : 'them'}, and nothing is lost
            from your file.
          </p>
        </Panel>
      )}

      {preview.problems.length > 0 && (
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left">
                <th className="label-caps px-4 py-3 text-[var(--color-muted)]">Rejected because</th>
                <th className="label-caps px-4 py-3 text-[var(--color-muted)]">Column</th>
                <th className="label-caps px-4 py-3 text-right text-[var(--color-muted)]">Rows</th>
                <th className="label-caps px-4 py-3 text-[var(--color-muted)]">For example</th>
              </tr>
            </thead>
            <tbody>
              {preview.problems.map((problem) => (
                <tr
                  key={`${problem.column ?? ''}|${problem.message}`}
                  className="border-b border-[var(--color-border)] align-top last:border-b-0"
                >
                  <td className="max-w-md px-4 py-3">{problem.message}</td>
                  <td className="px-4 py-3 text-[var(--color-muted)]">{problem.column ?? '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{problem.count}</td>
                  <td className="px-4 py-3 text-[var(--color-muted)]">
                    row{problem.lines.length === 1 ? '' : 's'} {problem.lines.join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {preview.sample.length > 0 && (
        <Panel className="p-5">
          <h3 className="text-base">The first few, as they would land</h3>
          <ul className="mt-3 space-y-1.5 text-sm">
            {preview.sample.map((row) => (
              <li key={row.line} className="flex flex-wrap gap-x-2 text-[var(--color-muted)]">
                <span className="tabular-nums">Row {row.line}</span>
                <span className="text-[var(--color-foreground)]">{row.label}</span>
                <span>
                  {row.action === 'create'
                    ? row.target === 'contact'
                      ? '— new contact, no account until they are invited'
                      : '— new'
                    : row.target === 'contact'
                      ? `— updates ${row.existing ?? 'a contact already on the list'}, still no account, matched on ${row.matchedBy}`
                      : row.existing
                        ? `— writes over ${row.existing}, matched on ${row.matchedBy}`
                        : `— updates the existing record, matched on ${row.matchedBy}`}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {preview.notes.map((note) => (
        <p key={note} className="max-w-prose text-sm text-[var(--color-muted)]">
          {note}
        </p>
      ))}

      {/*
        What happens if it goes wrong halfway, said before the button and not
        after. The code does exactly this — see commitImport in lib/csv/apply.ts.
      */}
      <Panel className="border-[var(--color-accent)] p-5">
        <h3 className="text-base">If something fails partway through</h3>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          The {preview.reject.toLocaleString('en-US')} rejected{' '}
          {preview.reject === 1 ? 'row is' : 'rows are'} never attempted. Of the rest, if
          a row is refused by the database after all this checking, everything already
          written stays written and you get a list of the rows that did not land. There
          is no undo, and there is no all-or-nothing option — creating a client is
          several steps across two systems and no single transaction covers them, so
          promising a rollback would be promising something that cannot happen.
        </p>
        <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
          Running a corrected file again is safe. The second run matches what the first
          run created and updates it instead of making a duplicate.
        </p>
        <div className="mt-5">
          <Button type="button" onClick={onCommit} disabled={busy || willWrite === 0}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} aria-hidden />
            ) : (
              <CheckCircle2 className="h-4 w-4" strokeWidth={1.5} aria-hidden />
            )}
            {willWrite === 0
              ? 'Nothing to import'
              : `Import ${willWrite.toLocaleString('en-US')} ${entity.label.toLowerCase()}`}
          </Button>
        </div>
      </Panel>
    </div>
  )
}

/* ── After ────────────────────────────────────────────────── */

function ResultPanel({ result, onReset }: { result: CommitResponse; onReset: () => void }) {
  const contacts = result.contactsCreated + result.contactsUpdated

  return (
    <div className="space-y-5">
      <div className={contacts > 0 ? 'grid gap-3 sm:grid-cols-2 lg:grid-cols-4' : 'grid gap-3 sm:grid-cols-3'}>
        <StatTile label="Created" value={result.created.toLocaleString('en-US')} />
        <StatTile label="Updated" value={result.updated.toLocaleString('en-US')} />
        {contacts > 0 && (
          <StatTile
            label="Added as contacts"
            value={contacts.toLocaleString('en-US')}
            hint={`${result.contactsCreated.toLocaleString('en-US')} new, ${result.contactsUpdated.toLocaleString('en-US')} already on the list`}
          />
        )}
        <StatTile
          label="Not written"
          value={(result.failed + result.rejected).toLocaleString('en-US')}
          hint={`${result.rejected} rejected before, ${result.failed} refused at the database`}
        />
      </div>

      {/*
        Said after the fact as plainly as the preview said it beforehand: these
        people are in the studio's records and cannot log in, and nothing about
        that changes on its own.
      */}
      {contacts > 0 && (
        <Panel className="p-5">
          <h3 className="text-base">The contacts still need inviting</h3>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            {contacts.toLocaleString('en-US')}{' '}
            {contacts === 1 ? 'person had' : 'people had'} no email address, so they
            are on the studio&rsquo;s list rather than holding an account.
            Nothing about them changes until somebody sends
            them an invitation and they claim it — which is also the moment their
            details stop being a note in a spreadsheet and become theirs to correct.
          </p>
          {result.importBatch && (
            <p className="mt-3 max-w-prose text-xs text-[var(--color-muted)]">
              Everything this run added shares one batch reference:{' '}
              <span className="font-mono text-[var(--color-foreground)]">
                {result.importBatch}
              </span>
              . It is kept on each contact, so this import can be found — or
              undone — as one thing rather than as a hundred rows.
            </p>
          )}
        </Panel>
      )}

      {result.failures.length > 0 && (
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left">
                <th className="label-caps px-4 py-3 text-[var(--color-muted)]">Row</th>
                <th className="label-caps px-4 py-3 text-[var(--color-muted)]">Which</th>
                <th className="label-caps px-4 py-3 text-[var(--color-muted)]">Why not</th>
              </tr>
            </thead>
            <tbody>
              {result.failures.map((failure) => (
                <tr
                  key={failure.line}
                  className="border-b border-[var(--color-border)] align-top last:border-b-0"
                >
                  <td className="px-4 py-3 tabular-nums">{failure.line}</td>
                  <td className="px-4 py-3">{failure.label}</td>
                  <td className="max-w-md px-4 py-3 text-[var(--color-muted)]">
                    {failure.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Button type="button" variant="subtle" onClick={onReset}>
        <RotateCcw className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        Import another file
      </Button>
    </div>
  )
}
