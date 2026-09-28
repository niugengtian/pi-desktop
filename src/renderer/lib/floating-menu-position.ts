export type FloatingMenuAnchor = {
  top: number;
  right: number;
  bottom: number;
};

export type FloatingMenuPositionInput = {
  anchor: FloatingMenuAnchor;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  padding?: number;
  gap?: number;
};

/** Position a fixed, body-portaled menu using its measured dimensions. */
export function floatingMenuPosition({
  anchor,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  padding = 8,
  gap = 4,
}: FloatingMenuPositionInput): { top: number; left: number } {
  const maxLeft = Math.max(padding, viewportWidth - menuWidth - padding);
  const left = Math.max(padding, Math.min(anchor.right - menuWidth, maxLeft));
  const roomBelow = viewportHeight - anchor.bottom - gap - padding;
  const roomAbove = anchor.top - gap - padding;
  const preferredTop =
    menuHeight <= roomBelow || roomBelow >= roomAbove ? anchor.bottom + gap : anchor.top - menuHeight - gap;
  const maxTop = Math.max(padding, viewportHeight - menuHeight - padding);
  const top = Math.max(padding, Math.min(preferredTop, maxTop));
  return { top, left };
}
