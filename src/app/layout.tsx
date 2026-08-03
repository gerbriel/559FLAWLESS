import { Suspense } from 'react'
import type { Metadata, Viewport } from 'next'
import { Cormorant_Garamond, Inter } from 'next/font/google'
import Script from 'next/script'
import { Toaster } from 'sonner'
import { ClientAnalytics } from '@/components/shared/ClientAnalytics'
import { createPublicClient } from '@/lib/supabase/public'
import './globals.css'

const display = Cormorant_Garamond({
  variable: '--font-cormorant',
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  display: 'swap',
})

const sans = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://559flawless.com'),
  title: {
    default: '559 Flawless — Facials, Waxing & Skin Treatments in Fresno',
    template: '%s — 559 Flawless',
  },
  description:
    'A private skin studio in Fresno. Custom facials, hard-wax hair removal, and corrective skin treatments by a licensed esthetician.',
  openGraph: {
    type: 'website',
    siteName: '559 Flawless',
    locale: 'en_US',
  },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  // Without this, env(safe-area-inset-*) resolves to 0 and anything padded for a
  // notch or a home indicator quietly falls back to its own floor.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf7f4' },
    { media: '(prefers-color-scheme: dark)', color: '#171110' },
  ],
}

type SiteSettings = {
  google_analytics_id?: string
  google_tag_manager_id?: string
  custom_head_scripts?: string
  custom_body_scripts?: string
}

async function getSiteSettings(): Promise<SiteSettings> {
  try {
    // Cookie-free on purpose. Analytics IDs are public config, and reading
    // cookies in the ROOT layout would opt the entire site — every marketing
    // page — out of static rendering.
    const supabase = createPublicClient()
    const { data } = await supabase
      .from('site_content')
      .select('key, value')
      .in('key', [
        'google_analytics_id',
        'google_tag_manager_id',
        'custom_head_scripts',
        'custom_body_scripts',
      ])

    const settings: SiteSettings = {}
    if (data) {
      for (const row of data) {
        // The value is stored as jsonb, so extract the actual value
        settings[row.key as keyof SiteSettings] =
          typeof row.value === 'object' && row.value && 'value' in row.value
            ? (row.value as { value: string }).value
            : (row.value as string)
      }
    }
    return settings
  } catch {
    return {}
  }
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const settings = await getSiteSettings()
  const isProduction = process.env.NODE_ENV === 'production'

  return (
    <html lang="en" className={`${display.variable} ${sans.variable} h-full antialiased`}>
      <head>
        {/* Google Analytics */}
        {isProduction && settings.google_analytics_id && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${settings.google_analytics_id}`}
              strategy="afterInteractive"
            />
            <Script id="google-analytics" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', '${settings.google_analytics_id}');
              `}
            </Script>
          </>
        )}

        {/* Google Tag Manager */}
        {isProduction && settings.google_tag_manager_id && (
          <Script id="google-tag-manager" strategy="afterInteractive">
            {`
              (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
              new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
              j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
              'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
              })(window,document,'script','dataLayer','${settings.google_tag_manager_id}');
            `}
          </Script>
        )}

        {/* Custom head scripts (admin configured, XSS risk if not properly sanitized) */}
        {isProduction && settings.custom_head_scripts && (
          <Script id="custom-head-scripts" strategy="afterInteractive">
            {settings.custom_head_scripts}
          </Script>
        )}
      </head>
      <body className="flex min-h-full flex-col">
        {/* Google Tag Manager (noscript) */}
        {isProduction && settings.google_tag_manager_id && (
          <noscript>
            <iframe
              src={`https://www.googletagmanager.com/ns.html?id=${settings.google_tag_manager_id}`}
              height="0"
              width="0"
              style={{ display: 'none', visibility: 'hidden' }}
            />
          </noscript>
        )}

        {/* ClientAnalytics reads useSearchParams, which forces any page that
            renders it to bail out of prerendering unless it sits behind a
            Suspense boundary. It lives in the root layout, so without this the
            whole site — including /login — fails to build. */}
        <Suspense fallback={null}>
          <ClientAnalytics />
        </Suspense>
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              borderRadius: 0,
              border: '1px solid var(--color-border)',
              background: 'var(--color-surface)',
              color: 'var(--color-foreground)',
            },
          }}
        />

        {/* Custom body scripts */}
        {isProduction && settings.custom_body_scripts && (
          <Script id="custom-body-scripts" strategy="lazyOnload">
            {settings.custom_body_scripts}
          </Script>
        )}
      </body>
    </html>
  )
}

