export interface MentionRange { start: number; end: number }

/** Offer references for a bare @ or @图 at the caret, not for email addresses. */
export function findMentionRange(text: string, start: number, end: number): MentionRange | null {
  if (start !== end || start < 0 || start > text.length) return null;
  const match = /(?:^|[^A-Za-z0-9._%+-])(@(?:图)?)$/u.exec(text.slice(0, start));
  return match ? { start: start - match[1].length, end: start } : null;
}

export function insertReferenceMention(text: string, range: MentionRange, position: number): { text: string; caret: number } {
  const marker = `@图${position + 1}`;
  const rest = text.slice(range.end);
  const separator = /^\s/u.test(rest) ? '' : ' ';
  return { text: text.slice(0, range.start) + marker + separator + rest, caret: range.start + marker.length + (separator || /^\s/u.test(rest) ? 1 : 0) };
}

/** Removing an earlier image would otherwise silently change a positional reference. */
export function affectedReferenceMarker(text: string, removedPosition: number): string | undefined {
  const chinese = '一二三四五六七八';
  for (const match of text.matchAll(/@图([1-8一二三四五六七八])(?![0-9A-Za-z_一二三四五六七八九十百千万零〇两])/gu)) {
    const position = /[1-8]/.test(match[1]) ? Number(match[1]) - 1 : chinese.indexOf(match[1]);
    if (position >= removedPosition) return match[0];
  }
  return undefined;
}
