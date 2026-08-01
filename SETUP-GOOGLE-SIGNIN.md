# Turning on Google sign-in

The button is already on the login and sign-up pages. It will not work until
Google and Supabase are told about each other — three screens, about ten
minutes.

## 1. Create the Google credentials

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. Create a project if you do not have one (any name — "559 Flawless").
3. **OAuth consent screen** first, or step 4 will refuse:
   - User type: **External**
   - App name: `559 Flawless`
   - Support email + developer email: your address
   - Authorised domain: `559flawless.vercel.app` (and your own domain later)
   - Scopes: leave the defaults. Supabase only needs email and profile.
   - Publish it. While it is in "Testing" only accounts you list can sign in.
4. **Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorised JavaScript origins:
     ```
     https://559flawless.vercel.app
     http://localhost:3000
     ```
   - Authorised redirect URI — this must be the **Supabase** callback, not the
     site's. Copy it from Supabase (next step); it looks like:
     ```
     https://<your-project-ref>.supabase.co/auth/v1/callback
     ```
5. Copy the **Client ID** and **Client secret**.

## 2. Tell Supabase

1. Supabase dashboard → **Authentication → Providers → Google**.
2. Enable it, paste the Client ID and Client secret, save.
3. The callback URL shown on that page is the one Google needs in step 1.4.

## 3. Set the redirect allow-list

Supabase → **Authentication → URL Configuration**:

- **Site URL:** `https://559flawless.vercel.app`
- **Redirect URLs** — add both, or sign-in will bounce to a blank page:
  ```
  https://559flawless.vercel.app/auth/callback
  http://localhost:3000/auth/callback
  ```

## What happens after someone signs in with Google

1. Supabase creates the auth user; the `handle_new_user` trigger creates their
   profile as a **client**. A `role` in the OAuth payload is ignored — anyone can
   put `{"role":"admin"}` in one, so self-signup is always a client and staff are
   promoted afterwards by an existing admin.
2. Google gives a name, an email and a picture. It does **not** give a phone
   number or a date of birth, and a booking needs both — so they land on
   **/account/complete** to fill those in once.
3. From there they go wherever they were headed. Someone who clicked "Book" and
   had to sign in first is returned to the booking, not dropped on a generic
   account page.

## Testing it

Use an incognito window and a Google account that is not already staff. You
should get: Google's account chooser → `/account/complete` → the booking page.
The new client appears under **Clients** in the dashboard straight away.
