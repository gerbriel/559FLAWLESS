import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Hides the floating Next.js dev badge in the corner. Dev-only UI — it never
  // shipped to production, but it gets in the way while building.
  devIndicators: false,

  images: {
    // Product and treatment imagery served from Supabase storage.
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co', pathname: '/storage/v1/object/public/**' },
    ],
    formats: ['image/avif', 'image/webp'],
  },
}

export default nextConfig
