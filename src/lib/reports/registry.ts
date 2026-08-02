// 559 Flawless — the report registry.
//
// One entry per report. The index page, the report runner and the CSV export
// route all read this and nothing else, so registering a module is the whole of
// "shipping a report" — there is no second list to keep in step.
//
// ADDING A REPORT
// ---------------
// Write `src/lib/reports/<file>.ts` exporting a ReportModule (see types.ts),
// then add exactly one line to ENTRIES below. Nothing else.
//
// The registry key is the URL segment AND must equal the module's own `key`
// field — `loadReport` refuses a module whose key disagrees, rather than letting
// it answer at someone else's URL and mis-file its CSV.
//
// Entries are lazy on purpose. `import()` keeps a report's query code out of the
// bundle until something asks for that report, and it means one module failing
// to load degrades to one missing card rather than a 500 on the index.

import type { ReportModule } from '@/lib/reports/types'

export type ReportGroup = 'money' | 'operations' | 'people'

export const REPORT_GROUPS: {
  key: ReportGroup
  title: string
  blurb: string
}[] = [
  { key: 'money', title: 'Money', blurb: 'What came in, what went out, and what the state is owed.' },
  { key: 'operations', title: 'Operations', blurb: 'The book, the room, and the shelf.' },
  { key: 'people', title: 'People', blurb: 'Clients and the team who look after them.' },
]

interface RegistryEntry {
  group: ReportGroup
  load: () => Promise<ReportModule>
}

const ENTRIES: Record<string, RegistryEntry> = {
  // ── Money ──────────────────────────────────────────────────
  sales: { group: 'money', load: () => import('./sales').then((m) => m.salesReport) },
  'sales-tax': { group: 'money', load: () => import('./sales-tax').then((m) => m.salesTaxReport) },
  'transaction-detail': { group: 'money', load: () => import('./transaction-detail').then((m) => m.transactionDetailReport) },
  expenses: { group: 'money', load: () => import('./expenses').then((m) => m.expensesReport) },
  'retail-sales': { group: 'money', load: () => import('./retail-sales').then((m) => m.retailSalesReport) },
  commissions: { group: 'money', load: () => import('./commissions').then((m) => m.commissionsReport) },

  // ── Operations ─────────────────────────────────────────────
  appointments: { group: 'operations', load: () => import('./appointments').then((m) => m.appointmentsReport) },
  'utilisation-retention': { group: 'operations', load: () => import('./utilisation-retention').then((m) => m.utilisationRetentionReport) },
  inventory: { group: 'operations', load: () => import('./inventory').then((m) => m.inventoryReport) },

  // ── People ─────────────────────────────────────────────────
  'most-valuable-clients': { group: 'people', load: () => import('./most-valuable-clients').then((m) => m.mostValuableClientsReport) },
  'staff-performance': { group: 'people', load: () => import('./staff-performance').then((m) => m.staffPerformanceReport) },
}

/**
 * Load one report module, or null if the key is not registered.
 *
 * Returns null rather than throwing so a route can answer 404 for an unknown
 * key, and so a broken module is indistinguishable from a typo in the URL to
 * anyone outside the server log.
 */
export async function loadReport(key: string): Promise<ReportModule | null> {
  const entry = ENTRIES[key]
  if (!entry) return null
  try {
    const found = await entry.load()
    if (found.key !== key) {
      console.error(`[reports] '${key}' is registered but the module calls itself '${found.key}'`)
      return null
    }
    return found
  } catch (error) {
    console.error(`[reports] failed to load '${key}'`, error)
    return null
  }
}

export interface ListedReport {
  report: ReportModule
  group: ReportGroup
}

/**
 * Every registered report that loads, with its group.
 *
 * One module throwing on import must not take the index down with it — the
 * others are still useful, and a manager standing at the desk is better served
 * by nine working reports and one missing card than by an error page.
 */
export async function listReports(): Promise<ListedReport[]> {
  const loaded = await Promise.all(
    Object.entries(ENTRIES).map(async ([key, entry]) => {
      const found = await loadReport(key)
      return found ? { report: found, group: entry.group } : null
    })
  )
  return loaded.filter((r): r is ListedReport => r !== null)
}
