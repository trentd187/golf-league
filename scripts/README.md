# Ops scripts

Standalone one-off scripts. This folder has its **own** `package.json` so its
dependencies stay isolated from the Expo app in `mobile/` (they never enter the app
bundle or `expo-doctor`).

```bash
cd scripts
npm install
```

## reprocess-avatars.mjs

Shrinks already-uploaded avatars in the Supabase `avatars` bucket to ≤512px JPEG.

**Why:** old profile photos were stored full-resolution (~2000px / ~1.8 MB). On web the
browser decodes each at full size, and avatar-heavy pages decoded enough at once to crash
the Chromium renderer (`STATUS_ILLEGAL_INSTRUCTION`). The app already fixes this two ways
— web avatars now lazy-load (`UserAvatar.web.tsx`) and new uploads are downscaled to
≤512px (`mobile/utils/avatar.ts`). **This script is optional cleanup** for the handful of
existing oversized avatars; it only reduces stored size / bandwidth. (Supabase image
transformations are disabled on our plan, so we resize the stored objects in place rather
than serving thumbnails via the render endpoint.)

**Run it** (dry-run first — it writes nothing until `--apply`):

```bash
SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service_role_key> \
node reprocess-avatars.mjs            # dry run: prints what it would resize

SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
node reprocess-avatars.mjs --apply    # actually resize + re-upload
```

The **service_role** key (Supabase Dashboard → Project Settings → API) is required to
list and overwrite every user's object. Never commit it.

> CDN note: re-uploaded objects may serve the old (cached) version for up to an hour
> (`Cache-Control: max-age=3600`) before the smaller image propagates.
