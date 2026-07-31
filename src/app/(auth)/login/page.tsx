import Link from 'next/link'
import type { Metadata } from 'next'
import { LoginForm } from '@/components/shared/LoginForm'

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

      <div className="mt-10">
        <LoginForm next={next} />
      </div>

      <p className="mt-8 text-sm text-[var(--color-muted)]">
        No account?{' '}
        <Link href="/signup" className="text-[var(--color-foreground)] underline underline-offset-4">
          Create one
        </Link>
      </p>
      <p className="mt-3 text-sm text-[var(--color-muted)]">
        You do not need an account to book — it just keeps everything in one place.
      </p>
    </div>
  )
}
