// scripts/reprocess-avatars.mjs
// One-off ops script: shrink already-uploaded avatars in the Supabase `avatars` bucket.
//
// Context: profile photos were stored as full-resolution originals (a real one is
// 1.8 MB / ~2000px). On web the browser decodes each at full size regardless of the
// 36px display, and avatar-heavy pages decoded enough of them at once to crash the
// Chromium renderer (STATUS_ILLEGAL_INSTRUCTION). The app now (a) lazy-loads avatars on
// web and (b) downscales new uploads to <=512px, so the crash is already fixed and new
// avatars stay small. This script is the cleanup for EXISTING oversized avatars — it is
// optional (lazy-loading already prevents the crash) and only reduces stored size /
// bandwidth. Supabase image transformations are disabled on our plan, so we resize and
// re-upload the objects in place rather than serving thumbnails via the render endpoint.
//
// Safety: dry-run by default — prints what it WOULD do. Pass --apply to write.
//
// Usage:
//   cd scripts && npm install
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service_role_key> \
//   node reprocess-avatars.mjs            # dry run
//   node reprocess-avatars.mjs --apply    # actually resize + re-upload
//
// The SERVICE ROLE key (Supabase Dashboard → Project Settings → API → service_role) is
// required to list/overwrite every user's object. Keep it out of source control.

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const BUCKET = "avatars";
const MAX_DIM = 512; // must match AVATAR_MAX_DIM in mobile/utils/avatar.ts
const JPEG_QUALITY = 80; // ~matches the app's 0.8 web/native upload quality

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APPLY = process.argv.includes("--apply");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing env. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running.",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Avatars live at `<userId>/avatar.jpg`, so the bucket root lists one "folder" per user.
async function listAvatarPaths() {
  const paths = [];
  const { data: folders, error } = await supabase.storage
    .from(BUCKET)
    .list("", { limit: 10000 });
  if (error) throw error;

  for (const folder of folders ?? []) {
    // Storage returns folders as entries with a null `id`; real files have an id.
    if (folder.id) {
      paths.push(folder.name); // a file at the root (unexpected, but handle it)
      continue;
    }
    const { data: files, error: e2 } = await supabase.storage
      .from(BUCKET)
      .list(folder.name, { limit: 100 });
    if (e2) throw e2;
    for (const f of files ?? []) paths.push(`${folder.name}/${f.name}`);
  }
  return paths;
}

async function processOne(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) {
    console.warn(`  skip ${path}: download failed (${error.message})`);
    return { skipped: true };
  }
  const input = Buffer.from(await data.arrayBuffer());
  const meta = await sharp(input).metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);

  if (longest <= MAX_DIM) {
    console.log(`  ok   ${path}: ${meta.width}x${meta.height} (${input.length} B) — already small`);
    return { skipped: true };
  }

  const output = await sharp(input)
    .rotate() // honor EXIF orientation before stripping metadata
    .resize(MAX_DIM, MAX_DIM, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  const pct = Math.round((1 - output.length / input.length) * 100);
  console.log(
    `  ${APPLY ? "RESIZE" : "would"} ${path}: ${meta.width}x${meta.height} ` +
      `${input.length} B → ${output.length} B (-${pct}%)`,
  );

  if (APPLY) {
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, output, { upsert: true, contentType: "image/jpeg" });
    if (upErr) {
      console.warn(`  FAILED ${path}: upload (${upErr.message})`);
      return { failed: true };
    }
  }
  return { resized: true };
}

async function main() {
  console.log(`Reprocess avatars — ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
  const paths = await listAvatarPaths();
  console.log(`Found ${paths.length} object(s) in "${BUCKET}".`);

  let resized = 0,
    skipped = 0,
    failed = 0;
  for (const path of paths) {
    const r = await processOne(path);
    if (r.resized) resized++;
    else if (r.failed) failed++;
    else skipped++;
  }

  console.log(
    `\nDone. ${APPLY ? "resized" : "would resize"}=${resized}, skipped=${skipped}, failed=${failed}.`,
  );
  if (!APPLY && resized > 0) console.log("Re-run with --apply to write the changes.");
  // Note: the CDN caches objects (max-age=3600); re-uploaded avatars may serve stale
  // for up to an hour before the smaller version propagates.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
