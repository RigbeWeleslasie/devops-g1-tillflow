# web — frontend / API shell

**DRI:** Rigbe (Product + POS) · **ECS service:** `devops-g1-web` · **ECR:** `devops-g1/web`
· **Stack:** Node 22 · TypeScript · Fastify · **No database of its own**

Server-rendered owner + attendant UI; proxies every write/read to the POS API (and, once
Nebyat's track lands, Payments). No client framework, no build step beyond `tsc` — plain
HTML forms and `POST`-redirect-`GET`, kept deliberately minimal so it proves the shell's
session/proxy plumbing rather than being a design exercise.

## Pages

| Route | Purpose |
| --- | --- |
| `GET /` | redirects to `/owner` or `/sell` based on the session cookie's role, or `/login` |
| `GET /login`, `POST /login` | mints a session via POS's `/dev/tokens` (see `services/pos/README.md`'s "Auth scope") |
| `GET /setup`, `POST /setup` | bootstraps a new tenant + owner via POS `POST /tenants` |
| `GET /owner`, `POST /owner/attendants`, `POST /owner/products`, `POST /owner/rates` | owner-only management, proxied to POS |
| `GET /sell`, `POST /sell` | attendant sale entry — creates a sale via POS `POST /sales` with a fresh `Idempotency-Key` per form submission |
| `GET /sell/:id`, `POST /sell/:id/pay` | sale status + the pay action; refresh after paying to see it flip to `PAID` once the async `sale.paid` event is consumed |

## Session model

A JWT (minted by POS) sits in an `httpOnly` cookie. The shell decodes it (without
verifying) only to decide which page to render — that is never the security boundary:
every actual read/write still sends the raw token to POS, which verifies it against the
real secret. A tampered cookie routes to the wrong page and then gets a 401 from POS on
the first real call, not elevated access.

## Local development

```bash
cd services/web
npm install       # from the repo root; this is an npm workspace
npm run build
npm test          # 4 tests, against a real in-process fake POS server (test/fakePos.ts)
npm run dev       # requires POS_BASE_URL
```

## What isn't proven yet

Same as `services/pos/README.md`: `Dockerfile` is written but not built or run (no Docker
available in this environment), and every test runs against `test/fakePos.ts` (a minimal
real HTTP server implementing just enough of the POS contract), not the real POS service
running side by side.

## Evidence

`evidence/product-pos/` (shared with `services/pos/` — this is the same Track A).
