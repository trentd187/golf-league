// utils/array.ts
// Shared array utility functions used across multiple screens.

// chunk splits an array into sub-arrays ("chunks") of the given size.
// The last chunk may be smaller than `size` if the array doesn't divide evenly.
//
// Example:
//   chunk([1, 2, 3, 4, 5], 2)  →  [[1, 2], [3, 4], [5]]
//   chunk(["a", "b", "c"], 3)  →  [["a", "b", "c"]]
//
// Usage: render a list as an N-column grid without duplicating the cell JSX.
export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  // Step through the array in increments of `size`, slicing each chunk out.
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
