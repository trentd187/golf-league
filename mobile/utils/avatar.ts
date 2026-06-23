// utils/avatar.ts
// Avatar image helpers shared by the profile upload path and the avatar components.
//
// Why this exists: profile photos were uploaded as full-resolution originals (a real
// one in the DB is 1.8 MB / ~2000px) and served at every size via getPublicUrl. Avatars
// render at <=40px, but a browser decodes the full bitmap (width*height*4 bytes) no
// matter the display size. The events/rounds detail screens render many avatars via
// .map() inside a plain ScrollView, so on web the simultaneous decodes drove Chromium
// into a memory-pressure renderer crash (STATUS_ILLEGAL_INSTRUCTION). Supabase image
// transformations (server-side thumbnails) are disabled on our plan — the render
// endpoint returns FeatureNotEnabled — so we cap the image client-side instead:
//   - resizeImageToJpegBuffer() shrinks WEB uploads before upload (this module),
//   - resizeNativeImageToJpegUri() shrinks iOS/Android uploads (this module), and
//   - UserAvatar.web.tsx lazy-loads so off-screen avatars never decode.
// Capping at the source on BOTH platforms means no client can store a multi-megapixel
// original, so a phone-uploaded avatar can no longer feed the web crash either.

import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

// Longest-edge cap for a stored avatar. 512px stays crisp at 2x for our largest (40px)
// avatar while bounding the decoded bitmap to ~1 MB (512*512*4) instead of ~16 MB.
export const AVATAR_MAX_DIM = 512;

// JPEG quality for the re-encoded avatar — matches expo-image-picker's native quality
// (0.8) so the web and native upload paths produce comparable files.
export const AVATAR_JPEG_QUALITY = 0.8;

// fitWithin caps source dimensions to a square `maxDim` bound while preserving aspect
// ratio. Pure (no DOM) so it is unit-tested directly; the canvas orchestration below
// delegates the math here. Returns the source unchanged when it already fits.
export function fitWithin(
  srcWidth: number,
  srcHeight: number,
  maxDim: number = AVATAR_MAX_DIM,
): { width: number; height: number } {
  if (srcWidth <= 0 || srcHeight <= 0) return { width: 0, height: 0 };

  const longest = Math.max(srcWidth, srcHeight);
  if (longest <= maxDim) {
    return { width: Math.round(srcWidth), height: Math.round(srcHeight) };
  }

  const scale = maxDim / longest;
  // Math.max(1, …) guards against a sub-pixel result rounding to 0 for extreme aspect
  // ratios, which would make canvas.width/height invalid.
  return {
    width: Math.max(1, Math.round(srcWidth * scale)),
    height: Math.max(1, Math.round(srcHeight * scale)),
  };
}

// resizeImageToJpegBuffer decodes an image Blob/File, downscales it so the longest edge
// is <= maxDim, and re-encodes it as JPEG — returning an ArrayBuffer ready for
// supabase.storage.upload. WEB ONLY: it uses createImageBitmap + a <canvas>, which exist
// only in the browser. The native upload path keeps expo-image-picker's own compression,
// so this is never called on iOS/Android.
export async function resizeImageToJpegBuffer(
  file: Blob,
  maxDim: number = AVATAR_MAX_DIM,
  quality: number = AVATAR_JPEG_QUALITY,
): Promise<ArrayBuffer> {
  // createImageBitmap decodes off the main thread; far cheaper than an <img> + onload.
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxDim);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (!blob) throw new Error("canvas.toBlob produced no blob");
    return await blob.arrayBuffer();
  } finally {
    // Release the decoded bitmap promptly — these are large and GC is non-deterministic.
    bitmap.close?.();
  }
}

// resizeNativeImageToJpegUri downscales a picked image so the longest edge is <= maxDim and
// re-encodes it as JPEG, returning a new local file URI ready for the existing
// fetch()->arrayBuffer()->supabase.storage.upload path. NATIVE only (iOS/Android): it uses
// expo-image-manipulator's native context API (createImageBitmap + <canvas> don't exist
// there). Mirrors resizeImageToJpegBuffer so neither platform stores a multi-megapixel
// original. srcWidth/srcHeight come from the expo-image-picker asset.
export async function resizeNativeImageToJpegUri(
  uri: string,
  srcWidth: number,
  srcHeight: number,
  maxDim: number = AVATAR_MAX_DIM,
  quality: number = AVATAR_JPEG_QUALITY,
): Promise<string> {
  const context = ImageManipulator.manipulate(uri);
  // Only schedule a resize when we actually need to shrink (this also guards bad/zero
  // dimensions, which would otherwise pass 0×0 to resize). We still always render+save as
  // JPEG below so the stored content type matches the web path.
  if (srcWidth > 0 && srcHeight > 0 && Math.max(srcWidth, srcHeight) > maxDim) {
    const { width, height } = fitWithin(srcWidth, srcHeight, maxDim);
    context.resize({ width, height });
  }
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: quality });
  return result.uri;
}
