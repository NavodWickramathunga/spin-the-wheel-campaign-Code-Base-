# Request: Move the "Spin the Wheel" campaign into Dialog's Firebase / Google Cloud

**To:** Dialog IT / Platform team  **From:** Navod Wickramathunga (E-Engagement)
**Decision needed:** confirmation and consent to host this project in a Dialog-governed Firebase project.

## 1. Why we are asking

The campaign currently runs in a personal Firebase project (`stw-spin-wheel-1443`, region `asia-southeast1`).
It handles customer mobile numbers and voucher codes, so it should run under Dialog's governance (access control,
billing, audit, retention), not a personal account. We ask to move the whole project into a Dialog-owned Firebase
project, in the same environment the internal MDA team already uses.

## 2. What the system does

Customers see a game (spin wheel, scratch card, gift box, flip card, slot machine) as a CleverTap in-app popup.
The popup calls our API. The server alone decides the prize, allocates a voucher code, and enforces caps and cooldowns.
An admin console manages prizes, voucher uploads, schedule, reports and customer lookup.

| Part | Technology | Notes |
|---|---|---|
| Static pages (popup, admin, studio) | Firebase Hosting | `public/` |
| API (`/api/**`) | One Cloud Function (Node 22, 2nd gen), `asia-southeast1` | `functions/index.js` |
| Data | Firestore | direct client access denied by `firestore.rules` |
| Secrets | Google Secret Manager | `ADMIN_PASS`, `STW_TOKEN_SECRET`, `STW_PII_KEY` |
| Popup delivery | CleverTap Custom HTML in-app | no change on CleverTap side except the API hostname |

No other third-party services, no analytics SDKs, no client-side database access.

## 3. Personal data and how it is handled

| Item | Handling |
|---|---|
| Mobile number (CleverTap Identity) | **Not stored.** Customers are keyed by `HMAC-SHA256(STW_PII_KEY, number)`. Reports show a masked number. |
| Customer request authenticity | Signed per-customer token (`stw_token`, HMAC with `STW_TOKEN_SECRET`); `TOKEN_MODE=enforce` rejects unsigned requests. |
| Voucher codes | Stored in Firestore until allocated; wins keep the code and hashed customer id. |
| Retention | Wins deleted after 90 days (configurable), spin counters 14 days, audit log 365 days, via Firestore TTL policies. |
| Admin access | Username + password (secret), lockout after 5 failures, audit log of every change. |
| Firestore direct access | Denied for all clients; only the Cloud Function (Admin SDK) reads/writes. |

## 4. What we need from IT

1. A Dialog-owned Google Cloud / Firebase project (or approval to use the existing MDA one) on the **Blaze** plan
   (required for Cloud Functions and Secret Manager), with Firestore in `asia-southeast1`.
2. Access for the project owner(s) / developer(s) who will deploy: roles Firebase Admin (or Hosting, Functions,
   Firestore, Secret Manager admin), plus a named IT owner for the project.
3. Confirmation of any Dialog policy that applies: data residency, security review, VPN/IP restrictions, a
   required custom domain (e.g. a Dialog hostname instead of `*.web.app`), and logging/monitoring standards.
4. Decision on who creates and holds the three secrets (recommended: IT sets them in Secret Manager so the developer never sees production values).
5. Decision on admin console access: keep username/password, or restrict to Dialog network/SSO.

## 5. Migration plan (proposed)

1. IT provisions the project and access (step 4.1 to 4.2).
2. Deploy code: `firebase deploy --only functions,hosting,firestore:rules` to the new project.
3. Set secrets. **`STW_PII_KEY` must never change once data exists**; a new key means new customer ids, so past winners would no longer be recognised.
4. Enable Firestore TTL: `gcloud firestore fields ttls update expire_at --collection-group=<wins|winners|spinners|audit|login_fails> --enable-ttl`.
5. Data: if the campaign is live, export from the old project and import into the new one; if it is pre-launch, start clean and re-upload vouchers and settings.
   The old project's `STW_PII_KEY` must be carried over in the first case.
6. Update the API hostname in the CleverTap HTML (`CONFIG` block; rebuild with `node templates/build.js`), test with a test identity, then switch the live campaign.
7. Shut down the personal project: delete Firestore data, disable the function and hosting, delete the project.

## 6. Risks and rollback

- Until step 6 the personal project keeps serving, so there is no downtime. Rollback is pointing the HTML back at the old hostname.
- Secret mismatch (`STW_TOKEN_SECRET`) would cause tokens issued by Dialog's backend to be rejected; use `TOKEN_MODE=log` first, then `enforce`.
- Costs: usage-based; expected volume is low (one function call per popup step). IT can set a budget alert.

## 7. Please reply with

- [ ] Approved to host in Dialog Firebase project: ______________ (project ID)
- [ ] IT owner: ______________
- [ ] Policy requirements / conditions: ______________
- [ ] Preferred hostname: ______________

The source is in this folder (`README.md` has the full technical detail). `node_modules/`, `wheel.db*`,
`firestore-debug.log`, `server.js` and `db.js` are local-development files and should not be transferred.
