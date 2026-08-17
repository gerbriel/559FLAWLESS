import Link from 'next/link'
import { Logo } from '@/components/layout/Logo'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--color-border)]">
        <div className="mx-auto flex h-20 max-w-6xl items-center px-6 lg:px-10">
          <Link href="/" className="flex min-h-11 items-center text-[var(--color-accent)]">
            <Logo className="h-14" />
          </Link>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  )
}
