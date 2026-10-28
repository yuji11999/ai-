export interface SelectOption { value: string; label: string; disabled?: boolean; title?: string }
export interface SelectMenuPosition { left: number; top: number; width: number; maxHeight: number }

export function selectMenuPosition(rect: { left: number; top: number; bottom: number; width: number }, viewport: { width: number; height: number }, count: number, minWidth: number, measuredHeight?: number): SelectMenuPosition {
  const margin = 8, gap = 6;
  const width = Math.min(Math.max(rect.width, minWidth), Math.max(0, viewport.width - margin * 2));
  const desired = Math.min(280, measuredHeight ?? count * 34 + 12);
  const above = Math.max(0, rect.top - margin - gap), below = Math.max(0, viewport.height - rect.bottom - margin - gap);
  const upward = below < desired && above > below;
  const maxHeight = Math.min(desired, upward ? above : below);
  return { left: Math.max(margin, Math.min(rect.left, viewport.width - width - margin)), top: upward ? rect.top - gap - maxHeight : rect.bottom + gap, width, maxHeight };
}

export function enabledOptionIndex(options: SelectOption[], start: number, direction: 1 | -1): number {
  for (let index = start; index >= 0 && index < options.length; index += direction) if (!options[index].disabled) return index;
  return -1;
}

export function matchingOptionIndex(options: SelectOption[], query: string, current: number): number {
  if (!query || !options.length) return -1;
  const term = query.toLocaleLowerCase();
  for (let offset = 1; offset <= options.length; offset++) {
    const index = (Math.max(-1, current) + offset) % options.length;
    const option = options[index];
    if (!option.disabled && option.label.toLocaleLowerCase().startsWith(term)) return index;
  }
  return -1;
}
