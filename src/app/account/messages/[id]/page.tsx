import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { MessageThreadView } from '@/components/shared/MessageThreadView'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

export default async function ThreadPage({ params }: Props) {
  const { id } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: thread } = await supabase
    .from('message_threads')
    .select('id, subject, status')
    .eq('id', id)
    .eq('client_id', user.id)
    .maybeSingle()

  if (!thread) notFound()

  // The client-side RLS policy on `messages` already filters out internal staff
  // notes; selecting them here would be filtered too, but we never ask for them.
  const { data: messages } = await supabase
    .from('messages')
    .select('id, body, sender_id, sender_name, created_at')
    .eq('thread_id', thread.id)
    .eq('is_internal', false)
    .order('created_at')

  // Clear the unread flag now that they're looking at it.
  await supabase
    .from('message_threads')
    .update({ client_unread: false })
    .eq('id', thread.id)

  return (
    <div>
      <Link href="/account/messages" className="label-caps text-[var(--color-muted)]">
        ← Messages
      </Link>

      <h1 className="display mt-8 text-3xl">{thread.subject}</h1>

      <div className="mt-10">
        <MessageThreadView
          threadId={thread.id}
          currentUserId={user.id}
          initialMessages={messages ?? []}
        />
      </div>
    </div>
  )
}
