import { FormsTabs } from '@/components/shared/FormsTabs'

/**
 * Paperwork, in one place.
 *
 * These three pages were previously scattered — consent templates behind a tab
 * on Services, intake templates nowhere at all, and "who still owes a form"
 * only discoverable by opening clients one at a time. They are one job.
 */
export default function FormsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h1 className="display text-3xl">Forms</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
        What clients fill in before treatment — health history, and the consent they
        give. Signed forms are kept verbatim and cannot be rewritten by editing a
        template later.
      </p>

      <FormsTabs />

      <div className="mt-10">{children}</div>
    </div>
  )
}
