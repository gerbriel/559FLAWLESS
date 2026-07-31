'use client'

import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter()

  return (
    <button
      onClick={async () => {
        await createClient().auth.signOut()
        router.push('/')
        router.refresh()
      }}
      className={cn(
        'label-caps inline-flex items-center gap-2 text-[var(--color-muted)] transition-colors hover:text-[var(--color-accent)]',
        className
      )}
    >
      <LogOut className="h-3.5 w-3.5" strokeWidth={1.75} />
      Sign out
    </button>
  )
}
