import { Suspense } from 'react'
import type { Metadata } from 'next'
import { LoginForm } from '@/components/shared/LoginForm'
import { GoogleSignIn } from '@/components/shared/GoogleSignIn'
import { AuthToggle } from '@/components/shared/AuthToggle'

export const metadata: Metadata = {
  title: 'Sign In',
  robots: { index: false, follow: false },
}

interface Props {
  searchParams: Promise<{ next?: string }>
}

export default async function LoginPage({ searchParams }: Props) {
  const { next } = await searchParams

  return (
    <div>
      <h1 className="display text-3xl">Welcome back.</h1>
      <p className="mt-3 text-sm text-[var(--color-muted)]">
        Sign in to see your appointments, forms, and order history.
      </p>

      <div className="mt-8">
        <AuthToggle />
      </div>

      <div className="mt-8">
        {/* Reads `next` from the URL, so it needs a boundary to prerender around. */}
        <Suspense fallback={null}>
          <GoogleSignIn label="Sign in with Google" />
        </Suspense>
        <LoginForm next={next} />
      </div>

      <p className="mt-8 text-sm text-[var(--color-muted)]">
        You will need an account to book, so we can keep your forms and history together.
      </p>
    </div>
  )
}
