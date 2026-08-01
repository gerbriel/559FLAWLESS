# Two-way Google Calendar sync

What it does once connected:

- **Bookings appear in your calendar** — client name and service, nothing
  clinical. Cancel in the app and the event disappears.
- **Your calendar blocks bookings** — a dentist appointment, the school run,
  anything already in there stops a client taking that slot.
- **Time off works from either side.** Block it in the app and it shows in your
  calendar; block it in your calendar and clients can't book it.

Events you have marked **Free** in Google are ignored, so an all-day "Birthday"
doesn't wipe out a working day.

---

## 1. Google Cloud

You can reuse the project from `SETUP-GOOGLE-SIGNIN.md` — it just needs one more
API and one more redirect URI.

1. **Enable the API**: APIs & Services → Library → search **Google Calendar
   API** → Enable.
2. **Add the scope**: OAuth consent screen → Scopes → Add →
   `https://www.googleapis.com/auth/calendar.events`.
   - This is the narrow scope: it can read and write *events*, and cannot
     create, delete, or change the sharing of a calendar itself.
   - Google treats it as **sensitive**. While the app is in Testing, only
     accounts on your test-user list can connect — which is fine, since the only
     person connecting a calendar is you. Publishing to Production with a
     sensitive scope triggers Google's verification review; you do not need that
     for a studio calendar.
3. **Add the redirect URI**: Credentials → your OAuth client → Authorised
   redirect URIs → add **both**:
   ```
   https://559flawless.vercel.app/api/calendar/callback
   http://localhost:3000/api/calendar/callback
   ```
   Note this is your **site's** callback, not Supabase's. Calendar access is
   handled by the app directly; only sign-in goes through Supabase.

## 2. Environment variables

In Vercel → Settings → Environment Variables (and your local `.env.local`):

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from the OAuth client |
| `GOOGLE_CLIENT_SECRET` | from the OAuth client |
| `CALENDAR_TOKEN_KEY` | `openssl rand -base64 32` |
| `CRON_SECRET` | `openssl rand -base64 32` |

**`CALENDAR_TOKEN_KEY` encrypts the refresh token before it reaches the
database.** A refresh token is a long-lived key to your personal calendar, so it
is never stored in plaintext — a leaked backup should not also be working Google
credentials. Losing this key isn't fatal: reconnect the calendar and a fresh
token is issued. Changing it invalidates existing connections.

`CRON_SECRET` is what authorises the hourly sync. Without it the scheduled sweep
refuses to run, which is the safe failure.

## 3. Connect

Dashboard → **My hours** → *Connect calendar*. You'll be asked to grant access,
then land back with the calendar connected.

Two switches are available afterwards, both on by default:

- **Block slots from my calendar** — the pull direction.
- **Put my bookings in the calendar** — the push direction.

## 4. How often it syncs

- **Pushing is immediate.** A booking, a cancellation, or a time-off block
  reaches Google within a second or two of being made.
- **Pulling runs hourly**, via the Vercel cron in `vercel.json`, plus whenever
  you press **Sync now**.

> **Vercel Hobby only runs cron jobs once a day.** If you're on Hobby, the
> hourly schedule silently becomes daily — meaning an appointment you add to
> Google this morning may not block a slot until tomorrow. Either upgrade to
> Pro, or press *Sync now* after changing your calendar. Pushing is unaffected.

---

## Notes on the design

**Nothing clinical leaves the app.** A pushed event carries the client's name and
the service. Intake answers, treatment notes, and consent records never go to
Google — a calendar entry syncs to every phone and watch signed into that
account, and health information does not belong there.

**Our own events don't block us.** Pushed events are tagged with a private
property, and the pull skips anything carrying it. Without that, the studio's own
bookings would come back as "external busy" and a cancelled appointment could
leave a phantom block behind if a delete ever failed.

**Sync replaces a window rather than accumulating.** Each pull rewrites 90 days
forward and 1 day back. Something deleted in Google stops blocking here; syncing
next month leaves this month alone.

**A failure never blocks a booking.** Pushes are fire-and-forget: the booking is
already committed and the client is waiting. If Google is slow or down, the next
sync reconciles rather than a client seeing an error for a slot they took.

**If access is revoked**, Google returns `invalid_grant`. That's recorded on the
connection and shown on the schedule page as *Access revoked* with a Reconnect
button, rather than retrying a dead token forever.
