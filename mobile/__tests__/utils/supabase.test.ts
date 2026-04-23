// __tests__/utils/supabase.test.ts
// Unit tests for the crypto.subtle polyfill in utils/supabase.ts.
// The polyfill only runs at module load time when globalThis.crypto.subtle is absent
// (React Native runtime). In the Node/Jest environment it's already present, so we
// test _subtleDigest directly — the extracted implementation that the polyfill delegates to.

// Stub out the three modules that supabase.ts side-effects at import time so Jest
// doesn't need real native modules or environment variables to load it.
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({})) }));
jest.mock('@react-native-async-storage/async-storage', () => ({}));
jest.mock('react-native-url-polyfill/auto', () => {});

// expo-crypto requires native modules — mock all surfaces used by the polyfill.
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { BASE64: 'base64' },
  digestStringAsync: jest.fn(() =>
    // base64-encoded SHA-256 of "hello"
    Promise.resolve('LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ='),
  ),
  getRandomValues: jest.fn((array: Uint8Array) => {
    // Fill with deterministic values so tests are reproducible.
    for (let i = 0; i < array.length; i++) array[i] = i % 256;
    return array;
  }),
}));

import { _subtleDigest } from '@/utils/supabase';

describe('_subtleDigest', () => {
  it('returns an ArrayBuffer when given a Uint8Array', async () => {
    const data = new TextEncoder().encode('hello');
    const result = await _subtleDigest('SHA-256', data);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBeGreaterThan(0);
  });

  it('returns an ArrayBuffer when given a plain ArrayBuffer', async () => {
    const data = new TextEncoder().encode('hello').buffer;
    const result = await _subtleDigest('SHA-256', data);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBeGreaterThan(0);
  });

  it('byte output matches the base64 returned by digestStringAsync', async () => {
    const data = new TextEncoder().encode('hello');
    const result = await _subtleDigest('SHA-256', data);
    const bytes = new Uint8Array(result);
    // Verify the first byte: base64 "LPJNul..." → 0x2C (44 decimal)
    expect(bytes[0]).toBe(44);
  });
});
