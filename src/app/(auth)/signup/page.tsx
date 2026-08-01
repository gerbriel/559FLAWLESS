import Link from 'next/link'
import type { Metadata } from 'next'
import { SignupForm } from '@/components/shared/SignupForm'

export const metadata: Metadata = {
  title: 'Create Account',
  robots: { index: false, follow: false },
}

export default function SignupPage() {
  return (
    <div>
      <h1 className="display text-3xl">Create your account.</h1>
      <p className="mt-3 text-sm text-[var(--color-muted)]">
        Keeps your appointments, forms, and history in one place — and means you only
        fill out intake once.
      </p>

      <div className="mt-10">
        <SignupForm />
      </div>

      <p className="mt-8 text-sm text-[var(--color-muted)]">
        Already have one?{' '}
        <Link href="/login" className="inline-flex min-h-11 items-center text-[var(--color-foreground)] underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </div>
  )
}
