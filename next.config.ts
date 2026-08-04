import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Hides the floating Next.js dev badge in the corner. Dev-only UI — it never
  // shipped to production, but it gets in the way while building.
  devIndicators: false,

  images: {
    remotePatterns: [
      // Studio-uploaded imagery.
      { protocol: 'https', hostname: '*.supabase.co', pathname: '/storage/v1/object/public/**' },
      // Official Rhonda Allison product photography. Retail is fulfilled by
      // their marketplace, so the product shots are served from the brand's CDN
      // rather than copied into this project.
      { protocol: 'https', hostname: 'cdn.shopify.com' },
      { protocol: 'https', hostname: 'ramarketplace.com' },
    ],
    formats: ['image/avif', 'image/webp'],
  },

  /**
   * Security headers, all of them in this one place.
   *
   * Deliberately ABSENT: Access-Control-Allow-Origin. Route handlers are
   * same-origin by default and every API here is meant to be called by this
   * site only — the missing header IS the protection. Adding CORS "to fix" a
   * blocked cross-origin call would be opening the API to that caller.
   */
  async headers() {
    // What the CSP is written against, so tightening it later starts from
    // facts rather than archaeology:
    //   - Checkout is by REDIRECT to Stripe; @stripe/stripe-js is not loaded,
    //     so js.stripe.com does not appear here.
    //   - Fonts are self-hosted by next/font at build time; no runtime
    //     fonts.googleapis.com requests exist.
    //   - Google Analytics loads from googletagmanager.com when the studio
    //     sets an id in site_settings (src/app/layout.tsx ~100).
    //   - Supabase is auth + PostgREST + storage over https and realtime over
    //     wss, all on *.supabase.co.
    //   - Product imagery comes from supabase storage, cdn.shopify.com and
    //     ramarketplace.com (see images.remotePatterns above).
    //   - The barcode scanner uses the camera via getUserMedia
    //     (BarcodeCameraScanner), so Permissions-Policy allows camera for
    //     this origin and the CSP allows blob: media.
    //   - 'unsafe-inline' for scripts is what Next's own bootstrap and the
    //     inline gtag snippet need without a nonce pipeline. That is the main
    //     thing to fix before enforcing.
    //
    // REPORT-ONLY on purpose. Enforcing a first CSP on a live booking site is
    // how a studio finds out at 9am that nobody can pay a deposit. Watch the
    // browser console (and any report endpoint added later) for violations;
    // when it has been quiet for a while, rename the header to
    // Content-Security-Policy and delete this sentence.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.supabase.co https://cdn.shopify.com https://ramarketplace.com https://www.googletagmanager.com https://*.google-analytics.com",
      "font-src 'self' data:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.google-analytics.com https://www.googletagmanager.com",
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
    ].join('; ')

    return [
      {
        source: '/(.*)',
        headers: [
          // Two years, preload-eligible. Vercel already serves HTTPS-only;
          // this stops a first request over http from ever being attempted.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          // A browser must never content-sniff its way into executing
          // something this app served as data — the CSV exports especially.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Nothing frames this app: not Stripe (redirect, not iframe), not
          // the marketing site (there is none besides this). Belt for old
          // browsers; frame-ancestors in the CSP is the modern half.
          { key: 'X-Frame-Options', value: 'DENY' },
          // Full URL to this origin, origin-only to everyone else — booking
          // paths can carry appointment ids and those stay out of referrers.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Camera stays available to this origin for the barcode scanner.
          // Everything else this app has no business asking for.
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(), geolocation=(), payment=()',
          },
          { key: 'Content-Security-Policy-Report-Only', value: csp },
        ],
      },
    ]
  },
}

export default nextConfig
