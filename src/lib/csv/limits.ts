/**
 * The bounds, in one place, because both the browser and the routes enforce
 * them and they have to be the same numbers.
 *
 * A limit is only useful if hitting it produces a sentence. Every one of these
 * has a message written next to it, and both sides use it — the browser so she
 * finds out before uploading anything, the route because the browser is not a
 * security boundary and a request can always arrive without going through it.
 * The failure mode being avoided is a serverless function that simply stops
 * responding, which tells her nothing and looks like a bug in the studio.
 */

/** 5 MB of text. A 5,000-line client list is well under one. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024

/**
 * Rows the parser will read at all. Larger than the import limit on purpose:
 * an over-large file is read far enough to be counted and named, rather than
 * being refused with "too big" and no number.
 */
export const PARSE_ROW_CEILING = 20_000

/**
 * Rows one import may write.
 *
 * A thousand is not a database limit — it is a wall-clock one. Each update is
 * its own request and each new client is three, so the work scales with the row
 * count, and a request that runs past the platform's timeout would leave a
 * half-finished import with no report of what landed. Splitting a larger file
 * in two is a minor inconvenience; not knowing what happened is not.
 */
export const MAX_IMPORT_ROWS = 1_000

/** How many rows the preview lists individually before it starts summarising. */
export const PREVIEW_SAMPLE = 25

export const LIMIT_MESSAGES = {
  fileTooLarge: `That file is larger than ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB. Export it in parts and import them one after another.`,
  tooManyRows: `That file has more than ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows. Split it and import the parts one after another — matching means the second part will update anything the first part created rather than duplicating it.`,
  empty: 'There are no rows in that file — only a header, or nothing at all.',
  noHeaders: 'That file has no header row, so there is nothing to map columns from.',
} as const
