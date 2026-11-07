// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from 'vitest';
import { sourceSymbolMatches } from '../lib/sourceSymbols.js';

describe('AST source navigation', () => {
  it('finds overloads and destructured bindings without treating comments and strings as code', () => {
    const text = '// select is not a reference\nconst note = "select()";\nexport function select(x: string): string;\nexport function select(x: number): number;\nexport function select(x: unknown) { return x; }\nconst { original: selectLocal, select } = source;\nselect(1);\n';
    const matches = sourceSymbolMatches({ path: 'source.ts', text, symbol: 'select' });
    expect(matches.map(row => [row.line, row.kind, row.role])).toEqual([
      [3, 'definition', 'declaration'], [4, 'definition', 'declaration'], [5, 'definition', 'declaration'],
      [6, 'definition', 'declaration'], [7, 'reference', 'call']
    ]);
    for (const match of matches) expect(text.slice(match.range.start, match.range.end)).toBe('select');
  });

  it('distinguishes imported aliases, reexports and actual calls while preserving Unicode positions', () => {
    const text = '/* λ𐐀 */ import { remote as नाम } from "lib";\nexport { नाम as exposed };\nconst other = नाम;\nनाम(1);\nobject.नाम(2);\nnew नाम();\n';
    const matches = sourceSymbolMatches({ path: 'source.ts', text, symbol: 'नाम' });
    expect(matches[0]!.kind).toBe('definition');
    expect(matches[1]!.kind).toBe('reference');
    const calls = sourceSymbolMatches({ path: 'source.ts', text, symbol: 'नाम', callsOnly: true });
    expect(calls.map(row => [row.line, row.role])).toEqual([[4, 'call'], [5, 'call'], [6, 'construct']]);
    for (const match of matches) expect(text.slice(match.range.start, match.range.end)).toBe('नाम');
  });

  it('reports an enclosing source span usable for a bounded read', () => {
    const text = 'export const wrapper = () => {\n  return invoke(1);\n};\n';
    const [match] = sourceSymbolMatches({ path: 'source.ts', text, symbol: 'invoke' });
    expect(match).toMatchObject({ line: 2, column: 10, enclosingRange: { startLine: 2, endLine: 2 } });
  });
});
