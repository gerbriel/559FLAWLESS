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
}

export default nextConfig
