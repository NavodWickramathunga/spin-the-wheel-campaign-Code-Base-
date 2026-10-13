# Spin the Wheel

Voucher spin-the-wheel campaign. Spin outcomes, voucher allocation, daily/weekly caps and the
repeat-winner cooldown are all decided server-side.

## Live (Firebase)

- Project: `stw-spin-wheel-1443` (region `asia-southeast1`)
- Admin controller: https://stw-spin-wheel-1443.web.app/admin.html
  (username is `ADMIN_USER` in `functions/.env`; the password is the `ADMIN_PASS` secret - see Security & privacy)
- Customer API: `https://stw-spin-wheel-1443.web.app/api/rewards`, `/api/spin`
- Data: Firestore (direct client access is denied by `firestore.rules`; everything goes through the `api` function)

Deploy everything from this folder:

    firebase deploy --only functions,hosting,firestore:rules

## Customer popup (CleverTap)

Paste one of the `clevertap-custom-html*.html` files into a CleverTap Custom HTML in-app campaign
(`-dialogpay` = Dialog Pay branding, `-neon`, `-refined-plus`, plain = alternative styles).
Settings live in the `CONFIG` block at the top of each file:

- `identity` uses `{{Profile.Identity}}` - the customer's mobile number from CleverTap.
- `token` uses `{{Profile.stw_token}}` - the customer's signed token (see Security & privacy).
- `defaultSegments` should match the admin "Wheel segments" so the first frame matches the live wheel.
- Outside the app (dashboard preview, desktop browser) the wheel runs a local preview spin; no voucher is issued.

Browser test page: `https://stw-spin-wheel-1443.web.app/?identity=TEST0001`
(each test identity can win once per cooldown period). With `TOKEN_MODE=enforce` the link also needs
`&token=...` - use **Copy test link** in the admin Customer lookup.

Before showing the wheel the popup asks the server (`/api/status`) whether this customer can play:
- wheel paused or outside the campaign schedule -> the popup closes itself without being seen;
- customer already won (cooldown) or used their spins -> it says why, and the button becomes Close.

### CleverTap campaign setup (do this - it is the main control)

- **Exclude recent winners:** target audience -> exclude users who did `Spin Wheel Result` with
  `action` = `won` in the last N days, where N = "Winner cooldown (days)" in the admin panel.
- **Match the schedule:** set the campaign's start/end date and delivery days/hours to the admin
  "Campaign schedule", so the popup isn't triggered outside it (a silent close may still count as an impression).
- Events sent by the popup: only two event names, because the CleverTap LIVE project is at its 512
  event-name limit and silently drops new names. `Spin Wheel Viewed` when the popup opens; every other step is
  `Spin Wheel Result` with an `action` property: `spun`, `result` (has `won`, `reward`), `won` (has
  `voucher_code`, `reward`, `voucher_value`), `claimed`, `code_copied`, `closed`, `not_shown` (paused/schedule),
  `not_eligible` (won/limit). Funnel: Viewed -> Result[action=spun] -> Result[action=won] -> Result[action=claimed].

## Games & Template Studio

Besides the wheel there are four games: **Scratch Card**, **Mystery Gift Box**, **Flip the Card** and
**Slot Machine**. They all use the same backend, prizes, vouchers, limits and schedule, and send the same
CleverTap events as the wheel (plus a `game` property), so the "exclude recent winners" rule covers all games.
In the gift box and flip card the other boxes/cards are only dimmed - the server decides the prize whichever
one is picked, so nothing pretends the customer "just missed" a prize.

- **Template Studio** (`/studio.html`, linked from the admin header): pick a game or wheel design, apply a
  colour theme, edit wording/logo/behaviour, sync the prize list, preview it live, then copy or download the
  CleverTap HTML. The backend address and the CleverTap Identity are always filled in correctly.
- Ready-made game files: `templates/*.html`. Previews: `/game-<name>.html` and `/wheel-<style>.html`.
- Source: `templates/src/shell.html` (shared: CleverTap bridge, status gate, result screen) +
  `templates/src/games/*.js` (one per game). After editing them, or a `clevertap-custom-html*.html` wheel, run
  `node templates/build.js` - it rebuilds `templates/*.html` and refreshes the copies in `public/`.

## Admin console

`/admin.html` - one app with a sidebar (each page has its own address, e.g. `admin.html#prizes`):

- **Dashboard:** live/paused/closed status, Pause button (top bar), plays and winners today, win rate,
  stock alerts, charts (plays/winners per day, plays by hour) and voucher stock. Refreshes every minute.
- **Games & templates:** gallery of all 8 designs with live thumbnails; Preview plays a demo round,
  Customise opens the **Template Studio** inside the console, Download saves the CleverTap HTML.
- **Prizes & vouchers:** segment weights with live win-chance %, per-reward daily limits, active switches,
  drag-and-drop voucher CSV upload, stock table.
- **Rules & schedule:** campaign schedule, winner caps, cooldown, plays per customer, low-stock %.
- **Customer lookup:** a customer's wins and codes, whether they can play; "Let them play again"; "Copy test link".
- **Winners & reports:** filterable table, day / all-time CSV (mobile numbers are masked, e.g. `*******4567`).
- **Team & access** (admins): own login per person; *Viewer* = read-only (managers), *Admin* = full control.
- **Activity log:** who changed what.

Save buttons only enable when something changed (invalid values are highlighted); risky actions ask
for confirmation. Viewers see everything with all editing controls hidden.

## Security & privacy

**Customer token.** The server only trusts an identity that comes with its signed token:
`token = base64url(HMAC-SHA256(STW_TOKEN_SECRET, TOKEN_CAMPAIGN + ":" + identity))` (identity without spaces/dashes).
Dialog's backend computes it and stores it on each CleverTap profile as `stw_token`, or for a fixed list run
`node tools/make-tokens.js identities.csv tokens.csv` (with `$env:STW_TOKEN_SECRET` set) and upload the CSV to CleverTap.
Changing `TOKEN_CAMPAIGN` invalidates every issued token. `TOKEN_MODE` in `functions/.env`:
- `off` (default) - not checked. The popup never says *why* a customer can't play (no "already won" leak).
- `log` - checked and failures logged (`stw: missing/invalid customer token` in the function logs), nothing blocked.
- `enforce` - spins and status without a valid token are refused. Turn on once the logs show tokens arriving.

**Mobile numbers are not stored.** Customers are keyed by `HMAC(STW_PII_KEY, identity)`; reports show a masked
number. Admin lookup still works by typing the number. Data written before this change: run once, signed in to the
admin page, in the browser console: `fetch('/api/admin/migrate-pii', {method:'POST', headers:{'X-STW-Admin':'1'}}).then(r => r.json()).then(console.log)`.

**Retention.** Wins are deleted `RETENTION_DAYS` (default 90) after the win; winner records after that or the
cooldown, whichever is longer; spin counters after 14 days; the audit log after 365 days. Enable the TTL policies once:

    for c in wins winners spinners audit login_fails; do
      gcloud firestore fields ttls update expire_at --collection-group=$c --enable-ttl --project=<project-id>
    done

**Secrets** are in Google Secret Manager, not `.env` (`STW_PII_KEY` must never change once data exists - it would
orphan every customer record):

    firebase functions:secrets:set ADMIN_PASS
    firebase functions:secrets:set STW_TOKEN_SECRET
    firebase functions:secrets:set STW_PII_KEY

Generate the two keys with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
`functions/.env` keeps only non-secret settings (`ADMIN_USER`, `TZ_OFFSET_MIN`, `TOKEN_MODE`, `TOKEN_CAMPAIGN`,
`RETENTION_DAYS`, `CORS_ORIGIN`) and must not also contain `ADMIN_PASS`.

**Admin sign-in.** 5 wrong passwords within 15 minutes lock that username for 15 minutes. Use a non-obvious
`ADMIN_USER` (anyone who knows it can trigger the lock). Changes are refused unless sent by the console itself.

**CORS.** `CORS_ORIGIN` is `*` by default. To restrict it, check the logs for the origin the app's webview sends
(blocked origins are logged as `stw: CORS origin not allowed`; webviews often send `null`) and set e.g.
`CORS_ORIGIN=null`. The admin API never allows other origins.

## Pre-demo checklist

1. Deploy (command above) and open the admin page - it must load without errors.
2. Upload the demo voucher CSV; check the stock table shows the expected counts.
3. Set segment weights and caps for the demo; untick any segment you don't want shown.
4. Spin with a few test identities on the browser test page; confirm wins appear under Winners.
5. Launch the CleverTap campaign to the test-user segment and spin once in the app on Android and iOS.

## Local server (legacy)

`server.js` is the original single-machine version using SQLite (`wheel.db`). It is not used by
the live Firebase setup. Run with `$env:ADMIN_PASS="yourpassword"; npm start` (Node 22.5+).
