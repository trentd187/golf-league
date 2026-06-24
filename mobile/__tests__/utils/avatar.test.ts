// __tests__/utils/avatar.test.ts
// Tests for the avatar image helpers: fitWithin (pure dimension math),
// resizeImageToJpegBuffer (the web canvas downscale) and resizeNativeImageToJpegUri
// (the native expo-image-manipulator downscale) used before upload.

// expo-image-manipulator is a native module; mock its contextual API so the native
// downscale orchestration can be asserted in the node test env. The chained context
// (manipulate -> resize -> renderAsync -> saveAsync) is captured via the _-prefixed
// handles below. jest.mock factories may only close over `mock`-prefixed vars, so we
// build the handles inside the factory and re-export them for the assertions.
jest.mock("expo-image-manipulator", () => {
  const resize = jest.fn();
  const saveAsync = jest.fn(async () => ({ uri: "file:///resized.jpg" }));
  const renderAsync = jest.fn(async () => ({ saveAsync }));
  const context = { resize, renderAsync };
  resize.mockReturnValue(context); // resize() is chainable — returns the context
  const manipulate = jest.fn(() => context);
  return {
    __esModule: true,
    SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
    ImageManipulator: { manipulate },
    // Test-only handles for asserting the chained calls.
    _manipulate: manipulate,
    _resize: resize,
    _saveAsync: saveAsync,
  };
});

import {
  fitWithin,
  resizeImageToJpegBuffer,
  resizeNativeImageToJpegUri,
  AVATAR_MAX_DIM,
  AVATAR_JPEG_QUALITY,
} from "@/utils/avatar";

describe("fitWithin", () => {
  it("returns source dimensions unchanged when already within the cap", () => {
    expect(fitWithin(300, 200, 512)).toEqual({ width: 300, height: 200 });
  });

  it("returns source unchanged when exactly at the cap", () => {
    expect(fitWithin(512, 400, 512)).toEqual({ width: 512, height: 400 });
  });

  it("scales a landscape image so the longest edge equals the cap", () => {
    expect(fitWithin(2000, 1000, 512)).toEqual({ width: 512, height: 256 });
  });

  it("scales a portrait image so the longest edge equals the cap", () => {
    expect(fitWithin(1000, 2000, 512)).toEqual({ width: 256, height: 512 });
  });

  it("scales a square image down to the cap", () => {
    expect(fitWithin(2048, 2048, 512)).toEqual({ width: 512, height: 512 });
  });

  it("never rounds a dimension below 1px for extreme aspect ratios", () => {
    const { width, height } = fitWithin(10000, 5, 512);
    expect(width).toBe(512);
    expect(height).toBe(1);
  });

  it("returns zeros for a non-positive source", () => {
    expect(fitWithin(0, 100)).toEqual({ width: 0, height: 0 });
    expect(fitWithin(100, -5)).toEqual({ width: 0, height: 0 });
  });

  it("defaults maxDim to AVATAR_MAX_DIM", () => {
    expect(fitWithin(AVATAR_MAX_DIM * 2, AVATAR_MAX_DIM * 2)).toEqual({
      width: AVATAR_MAX_DIM,
      height: AVATAR_MAX_DIM,
    });
  });
});

describe("resizeImageToJpegBuffer", () => {
  // Stub the browser image-decode + canvas APIs (absent in the jest node env) so the
  // orchestration can be exercised end to end.
  function installCanvasMocks(srcWidth: number, srcHeight: number) {
    const drawImage = jest.fn();
    const close = jest.fn();
    const resultBuffer = new ArrayBuffer(16);
    const toBlob = jest.fn(
      (cb: (b: Blob | null) => void) =>
        cb({ arrayBuffer: async () => resultBuffer } as unknown as Blob),
    );
    const canvas = {
      width: 0,
      height: 0,
      getContext: jest.fn(() => ({ drawImage })),
      toBlob,
    };
    (globalThis as unknown as { document: unknown }).document = {
      createElement: jest.fn(() => canvas),
    };
    (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap =
      jest.fn(async () => ({ width: srcWidth, height: srcHeight, close }));
    return { canvas, drawImage, toBlob, close, resultBuffer };
  }

  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
    delete (globalThis as unknown as { createImageBitmap?: unknown })
      .createImageBitmap;
  });

  it("downscales an oversized image and returns the encoded jpeg buffer", async () => {
    const { canvas, drawImage, close, resultBuffer } = installCanvasMocks(2000, 1000);

    const out = await resizeImageToJpegBuffer({} as Blob, 512, 0.8);

    // Canvas is sized to the fitWithin result, and drawImage uses those dimensions.
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(256);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 512, 256);
    expect(out).toBe(resultBuffer);
    // The decoded bitmap is released.
    expect(close).toHaveBeenCalled();
  });

  it("passes the requested jpeg quality to toBlob", async () => {
    const { toBlob } = installCanvasMocks(800, 800);
    await resizeImageToJpegBuffer({} as Blob, 512, 0.55);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.55);
  });

  it("throws when the canvas yields no blob", async () => {
    const drawImage = jest.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: jest.fn(() => ({ drawImage })),
      toBlob: jest.fn((cb: (b: Blob | null) => void) => cb(null)),
    };
    (globalThis as unknown as { document: unknown }).document = {
      createElement: jest.fn(() => canvas),
    };
    (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap =
      jest.fn(async () => ({ width: 800, height: 800, close: jest.fn() }));

    await expect(resizeImageToJpegBuffer({} as Blob)).rejects.toThrow(
      "canvas.toBlob produced no blob",
    );
  });

  it("throws when a 2d context is unavailable", async () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: jest.fn(() => null),
      toBlob: jest.fn(),
    };
    (globalThis as unknown as { document: unknown }).document = {
      createElement: jest.fn(() => canvas),
    };
    (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap =
      jest.fn(async () => ({ width: 800, height: 800, close: jest.fn() }));

    await expect(resizeImageToJpegBuffer({} as Blob)).rejects.toThrow(
      "2d canvas context unavailable",
    );
  });
});

describe("resizeNativeImageToJpegUri", () => {
  // The _-prefixed handles are the inner jest.fns of the expo-image-manipulator mock.
  const manip = require("expo-image-manipulator");

  beforeEach(() => {
    manip._manipulate.mockClear();
    manip._resize.mockClear();
    manip._saveAsync.mockClear();
  });

  it("downscales an oversized image and re-encodes it as JPEG, returning the new uri", async () => {
    const out = await resizeNativeImageToJpegUri("file:///photo.jpg", 2000, 1000, 512, 0.8);

    // Loads the source, schedules a proportional resize (fitWithin: 2000x1000 -> 512x256),
    // and saves as JPEG at the requested quality.
    expect(manip._manipulate).toHaveBeenCalledWith("file:///photo.jpg");
    expect(manip._resize).toHaveBeenCalledWith({ width: 512, height: 256 });
    expect(manip._saveAsync).toHaveBeenCalledWith({ format: "jpeg", compress: 0.8 });
    expect(out).toBe("file:///resized.jpg");
  });

  it("skips the resize action when the source already fits, but still saves JPEG", async () => {
    const out = await resizeNativeImageToJpegUri("file:///small.jpg", 300, 200, 512, 0.8);

    expect(manip._resize).not.toHaveBeenCalled();
    expect(manip._saveAsync).toHaveBeenCalledWith({ format: "jpeg", compress: 0.8 });
    expect(out).toBe("file:///resized.jpg");
  });

  it("skips the resize action for non-positive dimensions (guards bad picker metadata)", async () => {
    await resizeNativeImageToJpegUri("file:///bad.jpg", 0, 100);
    expect(manip._resize).not.toHaveBeenCalled();
    expect(manip._saveAsync).toHaveBeenCalled();
  });

  it("defaults maxDim and quality to the avatar constants", async () => {
    await resizeNativeImageToJpegUri("file:///big.jpg", AVATAR_MAX_DIM * 2, AVATAR_MAX_DIM * 2);

    // Default maxDim shrinks a 2x square to exactly the cap...
    expect(manip._resize).toHaveBeenCalledWith({
      width: AVATAR_MAX_DIM,
      height: AVATAR_MAX_DIM,
    });
    // ...and the default JPEG quality is applied.
    expect(manip._saveAsync).toHaveBeenCalledWith({
      format: "jpeg",
      compress: AVATAR_JPEG_QUALITY,
    });
  });
});
