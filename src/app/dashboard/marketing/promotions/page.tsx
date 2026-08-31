import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/dashboard'
import { PromotionManager, type PromotionUsage } from '@/components/shared/PromotionManager'
import { isAdmin, type UserRole, type Promotion } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * The deal board (068): every running and past promotion, editable — and the
 * referral programme's tally. Admin, not manager, because a promotion is a
 * pricing decision and `promotions` only has an admin write policy behind it.
 */
export default async function PromotionsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  if (!isAdmin((profile?.role ?? 'provider') as UserRole)) redirect('/dashboard/marketing')

  const [
    { data: promotions },
    { data: redemptions },
    { data: services },
    { data: categories },
    { data: referrals },
  ] = await Promise.all([
    supabase.from('promotions').select('*').order('created_at', { ascending: false }),
    supabase
      .from('promotion_redemptions')
      .select('promotion_id, discount_cents')
      .order('created_at', { ascending: false })
      .limit(5000),
    supabase
      .from('services')
      .select('id, name, category_id, is_active, price_cents')
      .order('sort_order')
      .order('name'),
    supabase.from('service_categories').select('id, name').order('sort_order'),
    supabase
      .from('referral_redemptions')
      .select(
        'id, reward_status, reward_cents, reward_percent, created_at, profiles!referral_redemptions_referrer_id_fkey(first_name, last_name)'
      )
      .order('created_at', { ascending: false })
      .limit(500),
  ])

  // Tallies per deal, computed once here rather than per row in the client.
  const usage = new Map<number, PromotionUsage>()
  for (const r of redemptions ?? []) {
    if (r.promotion_id === null) continue
    const u = usage.get(r.promotion_id) ?? { uses: 0, cents: 0 }
    u.uses += 1
    u.cents += r.discount_cents
    usage.set(r.promotion_id, u)
  }

  const referralRows = ((referrals ?? []) as unknown as {
    id: number
    reward_status: string
    reward_cents: number | null
    reward_percent: number | null
    created_at: string
    profiles: { first_name: string | null; last_name: string | null } | null
  }[]).map((r) => ({
    id: r.id,
    status: r.reward_status,
    rewardCents: r.reward_cents,
    rewardPercent: r.reward_percent,
    createdAt: r.created_at,
    referrer: `${r.profiles?.first_name ?? ''} ${r.profiles?.last_name ?? ''}`.trim() || 'Client',
  }))

  return (
    <div>
      <PageHeader
        title="Promotions"
        lede="Deals with dates on them, and the referral programme. Everything here applies itself — online, at the desk, and at the till."
      />

      <PromotionManager
        promotions={(promotions ?? []) as Promotion[]}
        usage={Object.fromEntries(usage)}
        services={services ?? []}
        categories={categories ?? []}
        referrals={referralRows}
      />
    </div>
  )
}
