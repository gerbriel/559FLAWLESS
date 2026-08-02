import {
  columnAlign,
  columnTotal,
  formatCell,
  isNumericColumn,
  type ReportColumn,
  type ReportRow,
} from '@/lib/reports/types'

/**
 * The one table every report renders through — standard modules and the custom
 * builder alike.
 *
 * It reads `columns` and nothing else: alignment, number formatting and the
 * footer total are all decided by what the module declared, so a report author
 * never writes markup and two reports can never drift into looking different.
 */
export function ReportTable({
  columns,
  rows,
  timeZone,
}: {
  columns: ReportColumn[]
  rows: ReportRow[]
  timeZone: string
}) {
  const totals = columns.map((c) => columnTotal(rows, c))
  const hasTotals = totals.some((t) => t !== null)

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-y border-[var(--color-border)]">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`label-caps whitespace-nowrap px-3 py-3 text-[var(--color-muted)] ${
                  columnAlign(c) === 'right' ? 'text-right' : 'text-left'
                }`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-[var(--color-border)]">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-3 py-3 ${
                    columnAlign(c) === 'right' ? 'text-right' : 'text-left'
                  } ${isNumericColumn(c) ? 'whitespace-nowrap tabular-nums' : ''}`}
                >
                  {formatCell(row[c.key], c, timeZone)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {hasTotals && (
          <tfoot>
            <tr className="border-b border-[var(--color-border)]">
              {columns.map((c, i) => {
                const total = totals[i]
                if (total === null) {
                  // The first cell carries the word, so the footer is not a row
                  // of figures with nothing saying what they are.
                  return (
                    <td key={c.key} className="label-caps px-3 py-3 text-[var(--color-muted)]">
                      {i === 0 ? 'Total' : ''}
                    </td>
                  )
                }
                return (
                  <td
                    key={c.key}
                    className={`whitespace-nowrap px-3 py-3 tabular-nums ${
                      columnAlign(c) === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {formatCell(total, c, timeZone)}
                    {c.total === 'avg' && (
                      <span className="ml-1 text-xs text-[var(--color-muted)]">avg</span>
                    )}
                  </td>
                )
              })}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
