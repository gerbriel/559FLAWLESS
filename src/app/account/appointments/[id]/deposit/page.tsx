import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { DepositRedirect } from '@/components/shared/DepositRedirect'
import { formatMoney } from '@/lib/utils'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

/**
 * Thin page whose only job is to kick off a Stripe Checkout session. The
 * session is created server-side from the appointment row, so the amount is
 * never anything the browser supplied.
 */
export default async function DepositPage({ params }: Props) {
  const { id } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: appointment } = await supabase
    .from('appointments')
    .select('id, deposit_cents, deposit_status, status')
    .eq('id', id)
    .eq('client_id', user.id)
    .maybeSingle()

  if (!appointment) notFound()

  if (appointment.deposit_status === 'paid' || appointment.deposit_cents <= 0) {
    redirect(`/account/appointments/${id}`)
  }

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="display text-3xl">Secure your appointment</h1>
      <p className="mt-4 text-[var(--color-muted)]">
        A {formatMoney(appointment.deposit_cents)} deposit holds your slot and comes off
        your total on the day.
      </p>
      <div className="mt-10">
        <DepositRedirect appointmentId={appointment.id} />
      </div>
    </div>
  )
}
