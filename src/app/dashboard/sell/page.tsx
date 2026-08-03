import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import {
  PointOfSale,
  type SellableProduct,
  type SellablePackage,
} from '@/components/shared/PointOfSale'
import { isFrontDesk, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/** Fresno County's combined rate, unless the studio has set its own. */
const DEFAULT_TAX_RATE = 0.0835

export default async function SellPage() {
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

  if (!isFrontDesk((profile?.role ?? 'provider') as UserRole)) {
    redirect('/dashboard')
  }

  const [{ data: products }, { data: clients }, { data: rateSetting }, { data: packages }] =
    await Promise.all([
    supabase
      .from('products')
      .select('id, name, sku, barcode, price_cents, stock_qty, unit, external_url, image_url, brands(name)')
      .eq('is_active', true)
      .eq('is_retail', true)
      .is('archived_at', null)
      .order('name'),
    supabase
      .from('profiles')
      .select('id, first_name, last_name, email')
      .eq('role', 'client')
      .is('suspended_at', null)
      .order('first_name')
      .limit(500),
    supabase
      .from('site_settings')
      .select('text_value')
      .eq('key', 'sales_tax_rate')
      .eq('is_active', true)
      .maybeSingle(),
    // Prepaid courses, on the same counter behind a switch. Fetched here so
    // the till does not have to ask for them from the browser after it has
    // already painted — PointOfSale falls back to its own request only when
    // this prop is absent.
    supabase
      .from('service_packages')
      .select('id, name, description, session_count, price_cents, valid_days, services(name)')
      .eq('is_active', true)
      .order('sort_order')
      .order('name'),
  ])

  const parsedRate = Number(rateSetting?.text_value)
  const taxRate =
    Number.isFinite(parsedRate) && parsedRate >= 0 && parsedRate < 1 ? parsedRate : DEFAULT_TAX_RATE

  const sellable: SellableProduct[] = (products ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    // Loaded up front so the common scan never touches the network.
    barcode: p.barcode,
    price_cents: p.price_cents,
    stock_qty: Number(p.stock_qty),
    unit: p.unit,
    external_url: p.external_url,
    // The till picks by sight, not by name — see PointOfSale.
    image_url: p.image_url,
    brand: (p.brands as { name: string } | null)?.name ?? null,
  }))

  const customers = (clients ?? []).map((c) => ({
    id: c.id,
    name: `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || (c.email ?? 'Client'),
    email: c.email,
  }))

  const sellablePackages: SellablePackage[] = (packages ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    service_name: (p.services as { name: string } | null)?.name ?? null,
    session_count: p.session_count,
    price_cents: p.price_cents,
    valid_days: p.valid_days,
  }))

  return (
    <div>
      <h1 className="display text-3xl">Sell</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
        Ring up a product at the counter. Stock comes off the shelf straight away and the
        sale lands on the client&rsquo;s history. Anything out of stock can be shipped from
        the Rhonda Allison store instead.
      </p>

      <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
        Prepaid courses are sold here too, under Packages —{' '}
        <Link
          href="/dashboard/packages"
          className="underline underline-offset-4 hover:text-[var(--color-foreground)]"
        >
          the catalogue and everyone&rsquo;s balances
        </Link>{' '}
        live on their own screen.
      </p>

      <PointOfSale
        products={sellable}
        customers={customers}
        taxRate={taxRate}
        packages={sellablePackages}
      />
    </div>
  )
}
