/** Cleanup errors must not replace the stream's outcome. */
export async function closeIterator(
  iterator?: AsyncIterator<unknown>,
): Promise<void> {
  try {
    await iterator?.return?.();
  } catch {
    // Iterators may throw synchronously or reject during cleanup.
  }
}
