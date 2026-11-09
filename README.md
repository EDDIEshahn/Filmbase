# FILMBASE

A streaming platform for licensed and public-domain films. Users browse a catalog, pick a subscription plan priced in Ugandan shillings (UGX), pay with MTN or Airtel mobile money, and stream titles. Stream quality is capped by plan. Admins add titles and publish them from a web panel.

FILMBASE streams only. It does not offer downloads of films, because downloads need DRM and a distribution license.

## Features

- Accounts with hashed passwords (scrypt) and signed, HttpOnly session cookies
- Catalog with search; unpublished titles are hidden from users
- Three plans: Basic UGX 5,000 (480p), Standard UGX 10,000 (720p), Premium UGX 20,000 (1080p), each billed every 30 days
- Mobile money checkout for MTN and Airtel Uganda numbers
- Payment webhook with signature check, amount and currency check, and idempotent activation
- Video streaming with HTTP Range support (seeking and fast start), gated by subscription and plan quality
- Admin panel to add, publish, and unpublish titles; titles need a license note before publishing
- Sandbox mode for testing with no real money, and live mode for Flutterwave
- 18 automated tests

## Requirements

- Node.js 18 or newer. No npm packages are needed.

## Quick start (sandbox)

```bash
cd filmbase
ADMIN_EMAIL=admin@yourdomain.com ADMIN_PASSWORD=change-me-now \
FLW_WEBHOOK_HASH=choose-a-long-random-string \
FB_SECRET=$(openssl rand -hex 32) \
npm start
```

Open http://localhost:3000. The admin panel is at http://localhost:3000/admin.

Run the tests:

```bash
npm test
```

## Adding content

1. Copy licensed or public-domain MP4 files into `media/`, for example `my-film-480.mp4` and `my-film-720.mp4`.
2. Sign in as the admin and go to `/admin`.
3. Fill in the title, year, genre, description, and a license note. Enter the file names for each quality.
4. Save, then click Publish.

Only add titles you own or have a written license to stream.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `FB_SECRET` | Signs session tokens. Set it in production or users are signed out on restart. | random |
| `FB_DATA_FILE` | Path to the JSON database | `data/db.json` |
| `FB_MEDIA_DIR` | Folder with video files | `media/` |
| `PAYMENT_MODE` | `sandbox` (no real charges) or `live` | `sandbox` |
| `FLW_SECRET_KEY` | Flutterwave secret key (live mode) | — |
| `FLW_WEBHOOK_HASH` | Secret hash Flutterwave sends in the `verif-hash` header. Required; webhooks are rejected without it. | — |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Creates the first admin account if none exists | — |
| `NODE_ENV` | `production` turns on Secure cookies (use HTTPS) | — |

## How payments work

1. The user picks a plan and enters a phone number. The server checks the number is a valid MTN or Airtel Uganda number.
2. The server creates a pending payment with a unique reference and sends a mobile money request (live mode). The user approves the prompt on their phone.
3. Flutterwave calls `POST /api/payments/webhook`. The server checks the `verif-hash` header, then in live mode re-verifies the transaction with Flutterwave. It also checks the status, currency (UGX), amount, and reference.
4. If everything matches, the payment becomes `paid` and the subscription is extended by 30 days. Repeated webhooks do nothing.
5. The browser polls the payment status and shows the result.

In sandbox mode nothing is charged. A payment stays pending until a correctly signed webhook arrives, so you can test the whole flow by posting one (the test suite does this).

## API summary

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | — | Status and payment mode |
| GET | `/api/plans` | — | Plans and quality tiers |
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Sign in |
| POST | `/api/auth/logout` | — | Clear session cookie |
| GET | `/api/auth/me` | user | Current user and subscription |
| GET | `/api/titles` | — | Published titles |
| GET | `/api/titles/:id` | — | One published title |
| POST | `/api/subscriptions/checkout` | user | `{planId, phone}` starts a payment |
| GET | `/api/payments/:ref` | user | Payment status |
| POST | `/api/payments/webhook` | `verif-hash` | Provider callback |
| GET | `/api/stream/:id?q=720` | subscriber | Video stream (Range supported) |
| GET/POST | `/api/admin/titles` | admin | List or create titles |
| PATCH | `/api/admin/titles/:id` | admin | Update or publish a title |
| GET | `/api/admin/payments` | admin | All payments |

## Going live checklist

- [ ] Put the site behind HTTPS and set `NODE_ENV=production`.
- [ ] Set `FB_SECRET`, `ADMIN_PASSWORD`, and `FLW_WEBHOOK_HASH` to long random values. Keep them out of the repository.
- [ ] Get a Flutterwave account with Uganda mobile money enabled. Set `PAYMENT_MODE=live`, `FLW_SECRET_KEY`, and `FLW_WEBHOOK_HASH`. Point the webhook URL to `https://yourdomain.com/api/payments/webhook`.
- [ ] Test with a small real payment before opening to the public. Check the MTN and Airtel prefix list in `lib/payments.js` against current operator data.
- [ ] Confirm the exact request and response fields against Flutterwave's current mobile money documentation. This code was written from the documented API shape and has not been tested against the live service.
- [ ] Add a rate limit on login and registration, and a proper reverse proxy (Nginx or Caddy).
- [ ] Move the JSON database to PostgreSQL or similar if you expect more than a few hundred concurrent users.
- [ ] Store video files on object storage or a CDN, and use signed URLs.
- [ ] Add refunds, receipts, password reset, and email verification.
- [ ] Get written licenses for every title and keep them on file.
- [ ] Have a lawyer review your terms of service, privacy policy, and any content license.

## Known limits

- Sign-out only clears the browser cookie. Tokens stay valid until they expire (7 days), so the server does not revoke them.
- Subscriptions are one-off 30-day payments. Recurring billing needs the provider's subscription or tokenization features.
- The JSON database is a single file, so it does not suit multiple servers.
