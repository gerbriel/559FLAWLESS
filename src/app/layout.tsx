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
    'A private skin studio in Fresno. Custom facials, hard-wax hair removal, and corrective skin treatments by a Licensed Cosmetologist.',
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
  facebook_pixel_id?: string
  tiktok_pixel_id?: string
  custom_head_scripts?: string
  custom_body_scripts?: string
}

/**
 * Tracking ids are interpolated into inline script bodies, where a stray quote
 * would close the string and run whatever follows as code. Only an admin can
 * set them — but "only an admin" is a fact about authorisation, not an escaping
 * strategy, and a stolen admin session should not also be a scripting primitive
 * on every page of the site.
 *
 * Every real GA, GTM, Meta and TikTok id is alphanumeric with dashes or
 * underscores. Anything else is not an id, so it is dropped rather than
 * sanitised into something that looks like one.
 */
/**
 * Pull the string out of a site_content row, whatever shape it is in.
 *
 * This is not defensive coding for its own sake — the shapes genuinely differ,
 * and the mismatch is why none of this ever worked. The tracking form writes
 * `{ id }` for a platform id and `{ scripts }` for the free-text boxes, while
 * this layout only ever looked for `{ value }`. Nothing matched, so a saved
 * Google Analytics id read back as an object, and the guard below it was
 * satisfied by the object being truthy — which put `[[object Object]]` into the
 * gtag URL rather than rendering nothing. Silently wrong, in production only,
 * which is the hardest place to notice it.
 *
 * `{ value }` stays accepted because it costs a line, and a shape this code
 * claimed to read for that long may well exist in somebody's row.
 */
function unwrap(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return undefined
  for (const key of ['id', 'scripts', 'value'] as const) {
    const held = (value as Record<string, unknown>)[key]
    if (typeof held === 'string' && held.trim()) return held
  }
  return undefined
}

function safeId(id: string | undefined): string | null {
  if (!id) return null
  const trimmed = id.trim()
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : null
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
        'facebook_pixel_id',
        'tiktok_pixel_id',
        'custom_head_scripts',
        'custom_body_scripts',
      ])

    const settings: SiteSettings = {}
    if (data) {
      for (const row of data) {
        const held = unwrap(row.value)
        if (held) settings[row.key as keyof SiteSettings] = held
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

  // Resolved once, so the guard and the interpolation can never disagree about
  // which value they are talking about.
  const gaId = isProduction ? safeId(settings.google_analytics_id) : null
  const gtmId = isProduction ? safeId(settings.google_tag_manager_id) : null
  const fbPixelId = isProduction ? safeId(settings.facebook_pixel_id) : null
  const tiktokPixelId = isProduction ? safeId(settings.tiktok_pixel_id) : null

  return (
    <html lang="en" className={`${display.variable} ${sans.variable} h-full antialiased`}>
      <head>
        {/* Google Analytics */}
        {gaId && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
              strategy="afterInteractive"
            />
            <Script id="google-analytics" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', '${gaId}');
              `}
            </Script>
          </>
        )}

        {/* Google Tag Manager */}
        {gtmId && (
          <Script id="google-tag-manager" strategy="afterInteractive">
            {`
              (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
              new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
              j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
              'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
              })(window,document,'script','dataLayer','${gtmId}');
            `}
          </Script>
        )}

        {/* Meta (Facebook) Pixel. The <noscript> half lives in <body>, where an
            image belongs — a pixel in <head> is not rendered by every browser. */}
        {fbPixelId && (
          <Script id="meta-pixel" strategy="afterInteractive">
            {`
              !function(f,b,e,v,n,t,s)
              {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
              n.callMethod.apply(n,arguments):n.queue.push(arguments)};
              if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
              n.queue=[];t=b.createElement(e);t.async=!0;
              t.src=v;s=b.getElementsByTagName(e)[0];
              s.parentNode.insertBefore(t,s)}(window,document,'script',
              'https://connect.facebook.net/en_US/fbevents.js');
              fbq('init', '${fbPixelId}');
              fbq('track', 'PageView');
            `}
          </Script>
        )}

        {/* TikTok Pixel */}
        {tiktokPixelId && (
          <Script id="tiktok-pixel" strategy="afterInteractive">
            {`
              !function (w, d, t) {
                w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var o=document.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};
                ttq.load('${tiktokPixelId}');
                ttq.page();
              }(window, document, 'ttq');
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
        {gtmId && (
          <noscript>
            <iframe
              src={`https://www.googletagmanager.com/ns.html?id=${gtmId}`}
              height="0"
              width="0"
              style={{ display: 'none', visibility: 'hidden' }}
            />
          </noscript>
        )}

        {/* Meta Pixel (noscript). eslint would have this be next/image; it is a
            1×1 beacon on a third-party host, and next/image would proxy it
            through the optimizer, which is the one thing a beacon must not be. */}
        {fbPixelId && (
          <noscript>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              height="1"
              width="1"
              alt=""
              style={{ display: 'none' }}
              src={`https://www.facebook.com/tr?id=${fbPixelId}&ev=PageView&noscript=1`}
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

