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
- **Pulling happens three ways:**
  1. **Opportunistically** — whenever someone loads the booking page for a
     provider whose cached calendar is more than 10 minutes old, a refresh is
     kicked off in the background. This is what actually protects slots in
     practice: by the time a client picks a time and presses book, the calendar
     has been re-read.
  2. **Daily at 6am Pacific** (`0 13 * * *` UTC), via the Vercel cron in
     `vercel.json` — before the studio opens.
  3. **On demand** — the *Sync now* button on My hours.

> **Vercel Hobby only allows daily cron jobs.** The schedule is set to daily so
> the deployment is accepted. That is coarse on its own, which is exactly why
> the opportunistic refresh above exists. If you upgrade to Pro, change the
> schedule in `vercel.json` to `"0 * * * *"` for an hourly sweep as well.

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

---

## The other scheduled jobs (migration 044)

Calendar sync is the only job that has to reach outside the database, so it is
the only one on a Vercel cron. Everything else — reminders, waitlist offers,
clock-in nudges, licence warnings, recurring expenses — runs on **pg_cron**,
inside Supabase, on every plan including the free one.

**Turn it on once:** Supabase Dashboard → Database → Extensions → search
`pg_cron` → enable. Then run migration `044_scheduled_jobs.sql`.

Until you do, migration 044 applies but schedules nothing and says so, and
Settings shows "Not scheduled yet". Those features still work — they just only
happen when someone presses the button on the relevant page.

| Job | Runs |
|---|---|
| Notifications and rebooking nudges | every 15 minutes |
| Waitlist offers | every 10 minutes |
| Clock in/out reminders | every 15 minutes, 5am–9pm Pacific |
| Licence expiry warnings | daily, ~8am Pacific |
| Recurring expenses | daily, small hours |

Times inside pg_cron are UTC, so a job pinned to a wall-clock hour drifts by one
hour across daylight saving. Each schedule above is either frequent enough that
it does not matter, or placed far enough from a boundary that an hour changes
nothing.

Every job is idempotent — running one twice sends nothing twice — so the
frequent schedules cost nothing when there is no work to do.

Check they are alive under **Settings → Background jobs**, which shows each
job's schedule and when it last ran.
