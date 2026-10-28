export type PreviewImage = { kind: 'result' | 'reference'; id: string; name: string };
export type PreviewSelection = { images: PreviewImage[]; index: number };

export function selectPreview(images: PreviewImage[], image: PreviewImage): PreviewSelection | null {
  const index = images.findIndex(item => item.id === image.id && item.kind === image.kind);
  return index < 0 ? null : { images, index };
}

export function movePreview(selection: PreviewSelection, direction: -1 | 1): PreviewSelection {
  const index = Math.max(0, Math.min(selection.images.length - 1, selection.index + direction));
  return index === selection.index ? selection : { ...selection, index };
}
