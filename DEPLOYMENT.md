# Deploying 559 Flawless

## GitHub Pages will not work for this site

Not a configuration problem — GitHub Pages only serves static files. It has no
server, which means no request-time code at all. This app needs one:

| Needs a server | Why |
|---|---|
| `/api/book` | The booking engine. Re-derives the slot server-side and writes with the service-role key — the key cannot ship to a browser. |
| `/api/availability` | Generates open slots from live schedules and existing bookings. |
| `/api/stripe/webhook` | Stripe posts here to confirm payment. A webhook needs a URL that can receive a POST. There is no way around this. |
| `/api/stripe/checkout`, `/api/stripe/deposit` | Create Checkout sessions using the Stripe secret key. |
| `src/proxy.ts` | Refreshes the auth cookie and gates `/account` and `/dashboard`. |
| `/dashboard/*`, `/account/*` | Rendered per signed-in user against row-level security. |

Forcing a static export (`output: 'export'`) does not degrade gracefully — it
fails the build on the API routes, and disables the proxy and every dynamic
page. What would survive is a brochure: the home page, the service menu, and the
policy pages. No booking, no client accounts, no staff dashboard, no payments.

That is roughly a fifth of what is built here, and the missing part is the point
of it.

## Use Vercel instead

Vercel is built by the Next.js team, the free tier covers a studio this size, and
it deploys straight from the GitHub repo you already have.

1. Go to [vercel.com/new](https://vercel.com/new) and sign in with GitHub.
2. Import **gerbriel/559FLAWLESS**. Framework is detected automatically — do not
   change the build settings.
3. Add the environment variables from `.env.example`:

   ```
   NEXT_PUBLIC_SUPABASE_URL
   NEXT_PUBLIC_SUPABASE_ANON_KEY
   SUPABASE_SERVICE_ROLE_KEY      <- mark as sensitive
   NEXT_PUBLIC_SITE_URL           <- your live URL
   STRIPE_SECRET_KEY              <- mark as sensitive
   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
   STRIPE_WEBHOOK_SECRET          <- mark as sensitive
   ```

4. Deploy. You get HTTPS and a `*.vercel.app` URL in about two minutes.
5. Point the real domain at it under **Settings → Domains**, then set
   `NEXT_PUBLIC_SITE_URL` to that domain and redeploy.

### After the first deploy

**Stripe webhook.** In the Stripe dashboard → Developers → Webhooks, add an
endpoint at `https://<your-domain>/api/stripe/webhook` listening for
`checkout.session.completed`, `checkout.session.expired`, and `charge.refunded`.
Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy. Until this is
done, deposits and product orders will be taken by Stripe but never marked paid
in the database.

**Supabase auth URLs.** In Supabase → Authentication → URL Configuration, set
the Site URL to your domain and add `https://<your-domain>/auth/callback` to the
redirect allow-list, or email confirmation and magic links will bounce.

## If GitHub Pages is a hard requirement

The only honest way to serve this from Pages is to split it:

- Marketing pages on GitHub Pages.
- Booking, accounts, dashboard, and payments on a host that runs a server, on a
  subdomain such as `book.559flawless.com`.

That means two deploys, two build pipelines, and a visible domain change when a
client clicks "Book now". It is strictly more work and a worse result than
pointing a domain at Vercel. Worth doing only if there is a reason Pages
specifically is required.

## Other hosts that work

Netlify and Cloudflare Workers both run Next.js 16 with adapters. Vercel needs no
adapter, so it is the shortest path.
