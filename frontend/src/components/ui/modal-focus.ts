/** Returns the wrapped destination index for a modal Tab cycle, if wrapping is needed. */
export function modalFocusDestination(
  activeIndex: number,
  focusableCount: number,
  backwards: boolean,
): number | undefined {
  if (focusableCount <= 0) return undefined
  if (backwards && activeIndex === 0) return focusableCount - 1
  if (!backwards && activeIndex === focusableCount - 1) return 0
  return undefined
}
