// __tests__/utils/array.test.ts
// Unit tests for the chunk() utility in utils/array.ts.

import { chunk } from "@/utils/array";

describe("chunk", () => {
  it("splits an array evenly", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("puts the remainder in the last chunk when the array does not divide evenly", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns a single chunk when size is larger than the array", () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it("returns single-element chunks when size is 1", () => {
    expect(chunk(["a", "b", "c"], 1)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("returns the full array as one chunk when size equals array length", () => {
    expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunk([], 2)).toEqual([]);
  });

  it("works with object arrays", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(chunk(items, 2)).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  });
});
