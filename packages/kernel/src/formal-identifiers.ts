// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
const IDENTIFIER_START = /^[\p{ID_Start}_$]$/u;
const IDENTIFIER_CONTINUE = /^[\p{ID_Continue}$]$/u;

export function isFormalIdentifierStart(character: string): boolean {
  return IDENTIFIER_START.test(character);
}

export function isFormalIdentifierContinue(character: string): boolean {
  return IDENTIFIER_CONTINUE.test(character);
}

/** Reads Unicode code points while retaining source UTF16 coordinates. */
export function readFormalIdentifier(text: string, start = 0): { value: string; end: number } | undefined {
  if (!Number.isSafeInteger(start) || start < 0 || start >= text.length) return undefined;
  const first = String.fromCodePoint(text.codePointAt(start)!);
  if (!isFormalIdentifierStart(first)) return undefined;
  if (start > 0) {
    const preceding = text.charCodeAt(start - 1);
    const previousStart = preceding >= 0xdc00 && preceding <= 0xdfff && start > 1
      && text.charCodeAt(start - 2) >= 0xd800 && text.charCodeAt(start - 2) <= 0xdbff ? start - 2 : start - 1;
    if (isFormalIdentifierContinue(String.fromCodePoint(text.codePointAt(previousStart)!))) return undefined;
  }
  let end = start + first.length;
  while (end < text.length) {
    const character = String.fromCodePoint(text.codePointAt(end)!);
    if (!isFormalIdentifierContinue(character)) break;
    end += character.length;
  }
  return { value: text.slice(start, end), end };
}

export function isFormalIdentifier(value: string): boolean {
  return Boolean(value.length && readFormalIdentifier(value)?.end === value.length);
}
