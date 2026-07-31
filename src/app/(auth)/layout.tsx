import Link from 'next/link'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--color-border)]">
        <div className="mx-auto flex h-20 max-w-6xl items-center px-6 lg:px-10">
          <Link href="/">
            <span className="display block text-2xl leading-none">559</span>
            <span className="label-caps block text-[0.625rem] text-[var(--color-accent)]">
              Flawless
            </span>
          </Link>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  )
}
