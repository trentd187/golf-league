# Keyboard and Cross-Platform Patterns

## Scrollable forms with inputs near the bottom — use `KeyboardAwareScrollView`

For a scroll view whose inputs can sit behind the keyboard (the scorecard), use
`KeyboardAwareScrollView` from `react-native-keyboard-controller`. It lifts the focused
input above the keyboard and insets the bottom **only while the keyboard is up** — no
permanent bottom whitespace, and no manual `scrollToEnd`/`scrollTo` on focus/blur.

```tsx
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

<KeyboardAwareScrollView
  contentContainerStyle={{ paddingBottom: 24 }}  // small resting pad only
  bottomOffset={24}                              // gap kept above the keyboard
  keyboardShouldPersistTaps="handled"
>
```

Requirements: `<KeyboardProvider>` must wrap the app once at the root (`app/_layout.tsx`),
and it's a native module (dev/preview build only — not Expo Go). See
[dependencies.md](dependencies.md). This **supersedes** the old pattern of a static
`paddingBottom` (≈320) plus a `scrollToEnd` ref call on `onFocus`. Field-to-field focus
chaining (`blurOnSubmit`/`returnKeyType`/`onSubmitEditing` → `.focus()` the next ref) is
unrelated and still used to keep the keyboard up while moving between inputs. Reference
implementation: `scorecard/[roundId].tsx`.

## KeyboardAvoidingView — always handle both platforms

Other screens still use React Native's built-in `KeyboardAvoidingView` for simple forms.
When you do, handle both platforms:

```tsx
// Correct — iOS gets "padding", Android gets "height"
<KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"}>

// Wrong — Android gets undefined (no keyboard avoidance at all)
<KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
```

`automaticallyAdjustKeyboardInsets` is iOS-only.

## Chaining TextInput focus without a keyboard reload

`blurOnSubmit` defaults to `true`, which dismisses the keyboard on Enter before `.focus()` on the next field re-opens it — visible as a jarring reload. Use this pattern:

```tsx
// On each TextInput that chains to a next field:
blurOnSubmit={nextTarget === null}   // false = keep keyboard up when there's a next field
returnKeyType={nextTarget !== null ? "next" : "done"}
onSubmitEditing={() => {
  if (nextTarget !== null) nextInputRef.current?.focus();
}}
```

Keeping the focused field on screen is handled by `KeyboardAwareScrollView` (see the
section above), so no `onFocus`/`onBlur` scroll glue is needed. See
`scorecard/[roundId].tsx` numeric stat → score chaining for a full example.

## Platform-split rendering

Platform-split rendering (e.g. Android dialog vs iOS modal sheet for date pickers) is intentional and correct — just ensure both branches are complete and tested.

## File upload from React Native (Supabase Storage)

React Native's `BlobManager` has limitations, but they are mitigated when uploading to Supabase Storage. The `fetch(file://)` approach works because Supabase's storage client accepts a separate `contentType` option:

```tsx
const fileResponse = await fetch(asset.uri);
const blob = await fileResponse.blob();

const { error } = await supabase.storage
  .from("avatars")
  .upload(`${user.id}/avatar.jpg`, blob, { upsert: true, contentType: mimeType });

const { data: { publicUrl } } = supabase.storage.from("avatars").getPublicUrl(`${user.id}/avatar.jpg`);
await supabase.auth.updateUser({ data: { avatar_url: publicUrl } });
```

Used in `app/(tabs)/profile.tsx`. No backend proxy needed. (The real upload uploads an
`ArrayBuffer`, not a `Blob` — on Android RN's fetch bridge fails to serialize Blob binary
for outbound HTTPS; `arrayBuffer()` bypasses it.)

**Always downscale avatars to ≤512px JPEG before upload — both platforms.** A full-res
phone photo (a real one is 1.8 MB / ~2000px) stored verbatim is decoded full-size by every
viewer; on web, many such decodes at once crashed the renderer
(`STATUS_ILLEGAL_INSTRUCTION`). Supabase server-side image transforms are disabled on our
plan, so the cap is client-side in [`utils/avatar.ts`](../utils/avatar.ts):

- **Web** branch → `resizeImageToJpegBuffer(file)` (canvas `createImageBitmap` + `toBlob`).
- **Native** branch → `resizeNativeImageToJpegUri(asset.uri, asset.width, asset.height)`
  (expo-image-manipulator `manipulate().resize().renderAsync().saveAsync()`), then
  `fetch(resizedUri).arrayBuffer()`.

Both re-encode to JPEG, so the upload `contentType` is a fixed `"image/jpeg"`. Shared
dimension math + the 512px / 0.8-quality constants live in the same module. See
[components.md](components.md) `UserAvatar` for the web lazy-load half of the fix.
