'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Select } from '@/components/ui/field'
import type { ThreadStatus } from '@/types/database'

const OPTIONS: { value: ThreadStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Waiting on client' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'archived', label: 'Archived' },
]

export function ThreadStatusControl({
  threadId,
  status,
}: {
  threadId: string
  status: ThreadStatus
}) {
  const router = useRouter()
  const [value, setValue] = useState<ThreadStatus>(status)

  async function change(next: ThreadStatus) {
    const previous = value
    setValue(next)

    const { error } = await createClient()
      .from('message_threads')
      .update({ status: next })
      .eq('id', threadId)

    if (error) {
      setValue(previous)
      toast.error('Could not update the status.')
      return
    }

    router.refresh()
  }

  return (
    <Select
      value={value}
      onChange={(e) => change(e.target.value as ThreadStatus)}
      aria-label="Thread status"
      className="w-48"
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  )
}
