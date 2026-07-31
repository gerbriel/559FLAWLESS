// Allow-list driven CORS. ALLOWED_ORIGINS is a comma-separated env var, e.g.
// "https://559flawless.com,https://www.559flawless.com,http://localhost:3000".
// An unknown origin gets no Access-Control-Allow-Origin header at all, which
// is what makes the browser refuse the response.

const configured = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  const base: Record<string, string> = {
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }

  // No allow-list configured (local dev) → echo the origin back.
  if (configured.length === 0) {
    return origin ? { ...base, 'Access-Control-Allow-Origin': origin } : base
  }
  if (configured.includes(origin)) {
    return { ...base, 'Access-Control-Allow-Origin': origin }
  }
  return base
}
