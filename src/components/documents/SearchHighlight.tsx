import React, { type ReactNode } from 'react';

export interface HighlightRange {
  start: number;
  end: number;
}

export function SearchHighlight({ text, ranges, query }: { text: string; ranges?: HighlightRange[]; query?: string }) {
  const valid = (Array.isArray(ranges) ? ranges : [])
    .filter(range => range && Number.isInteger(range.start) && Number.isInteger(range.end)
      && range.start >= 0 && range.end > range.start && range.end <= text.length)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const term = query?.trim();
  if (valid.length === 0 && term) {
    const escapeTerm = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const terms = [...new Set([term, ...term.split(/\s+/)])].sort((a, b) => b.length - a.length);
    const pattern = new RegExp(terms.map(escapeTerm).join('|'), 'gi');
    for (const match of text.matchAll(pattern)) {
      valid.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  const merged: HighlightRange[] = [];
  for (const range of valid) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  const parts: ReactNode[] = [];
  let position = 0;
  for (const range of merged) {
    parts.push(text.slice(position, range.start));
    parts.push(<mark key={range.start}>{text.slice(range.start, range.end)}</mark>);
    position = range.end;
  }
  parts.push(text.slice(position));
  return <>{parts}</>;
}
