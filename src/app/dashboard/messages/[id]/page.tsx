import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { MessageThreadView } from '@/components/shared/MessageThreadView'
import { ThreadStatusControl } from '@/components/shared/ThreadStatusControl'
import { Badge } from '@/components/ui/badge'
import type { ThreadStatus } from '@/types/database'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

export default async function StaffThreadPage({ params }: Props) {
  const { id } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: thread }, { data: profile }] = await Promise.all([
    supabase
      .from('message_threads')
      .select(
        'id, subject, status, guest_name, guest_email, guest_phone, client_id, profiles!message_threads_client_id_fkey(first_name, last_name, email, phone)'
      )
      .eq('id', id)
      .maybeSingle(),
    supabase.from('profiles').select('first_name, display_name').eq('id', user.id).maybeSingle(),
  ])

  if (!thread) notFound()

  // Staff see internal notes too — the client-facing policy filters them out.
  const { data: messages } = await supabase
    .from('messages')
    .select('id, body, sender_id, sender_name, is_internal, created_at')
    .eq('thread_id', thread.id)
    .order('created_at')

  await supabase
    .from('message_threads')
    .update({ staff_unread: false })
    .eq('id', thread.id)

  const client = thread.profiles as {
    first_name: string | null
    last_name: string | null
    email: string | null
    phone: string | null
  } | null

  return (
    <div className="max-w-3xl">
      <Link href="/dashboard/messages" className="label-caps text-[var(--color-muted)]">
        ← Messages
      </Link>

      <div className="mt-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="display text-2xl">{thread.subject}</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {client ? (
              <>
                <Link
                  href={`/dashboard/clients/${thread.client_id}`}
                  className="underline underline-offset-4"
                >
                  {client.first_name} {client.last_name}
                </Link>
                {client.email && ` · ${client.email}`}
                {client.phone && ` · ${client.phone}`}
              </>
            ) : (
              <>
                {thread.guest_name}
                {thread.guest_email && ` · ${thread.guest_email}`}
                {thread.guest_phone && ` · ${thread.guest_phone}`}
                <Badge tone="neutral" className="ml-3">
                  No matching client
                </Badge>
              </>
            )}
          </p>
        </div>

        <ThreadStatusControl threadId={thread.id} status={thread.status as ThreadStatus} />
      </div>

      <div className="mt-10">
        <MessageThreadView
          threadId={thread.id}
          currentUserId={user.id}
          initialMessages={messages ?? []}
          asStaff
          staffName={profile?.display_name ?? profile?.first_name ?? '559 Flawless'}
        />
      </div>
    </div>
  )
}
