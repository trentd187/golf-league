# Keyboard and Cross-Platform Patterns

## KeyboardAvoidingView — always handle both platforms

```tsx
// Correct — iOS gets "padding", Android gets "height"
<KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"}>

// Wrong — Android gets undefined (no keyboard avoidance at all)
<KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
```

`automaticallyAdjustKeyboardInsets` is iOS-only. On Android, use `behavior="height"` plus a `scrollToEnd` ref call on `onFocus` for inputs near the bottom of the screen (see `scorecard/[roundId].tsx`).

`paddingBottom` for scrollable forms with inputs near the bottom: use **at least 320** so `scrollToEnd` has room to move the focused input above the keyboard on both platforms.

## Chaining TextInput focus without a keyboard reload

`blurOnSubmit` defaults to `true`, which dismisses the keyboard on Enter before `.focus()` on the next field re-opens it — visible as a jarring reload. Use this pattern:

```tsx
const focusingRef = useRef(false);

// On each TextInput that chains to a next field:
blurOnSubmit={nextTarget === null}   // false = keep keyboard up when there's a next field
returnKeyType={nextTarget !== null ? "next" : "done"}
onSubmitEditing={() => {
  if (nextTarget !== null) {
    focusingRef.current = true;      // suppress onBlur's scroll-to-top
    nextInputRef.current?.focus();
  }
}}
onFocus={() => {
  // scroll-to-end for bottom inputs (150 ms delay)
  setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
}}
onBlur={() => {
  if (!focusingRef.current) {
    // keyboard actually dismissed — reset scroll
    setTimeout(() => scrollRef.current?.scrollTo({ x: 0, y: 0, animated: true }), 150);
  }
  focusingRef.current = false;
}}
```

See `scorecard/[roundId].tsx` numeric stat → score chaining for a full example.

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

Used in `app/(tabs)/profile.tsx`. No backend proxy needed.
