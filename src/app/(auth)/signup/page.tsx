import { Suspense } from 'react'
import type { Metadata } from 'next'
import { SignupForm } from '@/components/shared/SignupForm'
import { GoogleSignIn } from '@/components/shared/GoogleSignIn'
import { AuthToggle } from '@/components/shared/AuthToggle'

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

      <div className="mt-8">
        <AuthToggle />
      </div>

      <div className="mt-8">
        <Suspense fallback={null}>
          <GoogleSignIn label="Sign up with Google" />
        </Suspense>
        <SignupForm />
      </div>
    </div>
  )
}
