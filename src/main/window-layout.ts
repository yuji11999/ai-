export interface WorkArea { x: number; y: number; width: number; height: number }

/** Use Electron's logical pixels so Windows display scaling is accounted for. */
export function initialWindowBounds(area: WorkArea) {
  const availableWidth = Math.max(1, Math.floor(area.width));
  const availableHeight = Math.max(1, Math.floor(area.height));
  const preferredWidth = Math.max(1, Math.floor(availableWidth * 0.9));
  const preferredHeight = Math.max(1, Math.floor(availableHeight * 0.9));
  const minWidth = Math.min(1100, preferredWidth);
  const minHeight = Math.min(720, preferredHeight);
  const width = Math.min(1280, preferredWidth);
  const height = Math.min(800, preferredHeight);
  return { x: area.x + Math.floor((availableWidth - width) / 2), y: area.y + Math.floor((availableHeight - height) / 2), width, height, minWidth, minHeight };
}
