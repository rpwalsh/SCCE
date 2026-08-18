// Structural coherence scoring for answer prose. Zero language-specific
// word lists: every check keys on script-neutral structure (casing shape,
// sentence boundaries, bracket/quote balance), so it can never encode an
// English-only judgment. These are exactly the defect families a human
// reviewer flagged in the rehearsal raw answers that the required-string
// scorer scored 1.0: mid-phrase truncation stitches, lowercase-initial
// fragments, unbalanced quoting, and answers that are one bare token.

const BOUNDARIES = new Set([".", "!", "?", "。", "！", "？", "؟", "۔", "।", "॥", "።", "။"]);

function sentences(text) {
  const out = [];
  let current = "";
  for (const char of String(text ?? "").normalize("NFC")) {
    if (char === "\n" || char === "\r") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
    if (BOUNDARIES.has(char)) {
      if (current.trim()) out.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function isCasedLower(char) {
  return char.toLocaleLowerCase() !== char.toLocaleUpperCase() && char !== char.toLocaleUpperCase();
}

function balanced(text, open, close) {
  let depth = 0;
  for (const char of text) {
    if (char === open) depth++;
    else if (char === close) depth = Math.max(-1, depth - 1);
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Returns { coherent: boolean, defects: string[] } for an answer's prose
 * body (content before the first blank line, so attribution/source lines
 * are not judged as prose).
 */
export function coherenceFindings(answer) {
  const body = String(answer ?? "").split(/\n\s*\n/u)[0] ?? "";
  const defects = [];
  const rows = sentences(body).filter(sentence => !sentence.includes("://"));
  if (!rows.length) {
    defects.push("empty_body");
    return { coherent: false, defects };
  }
  const units = body.trim().split(/\s+/u).filter(Boolean);
  if (units.length <= 3 && !rows.some(row => BOUNDARIES.has([...row].at(-1) ?? ""))) {
    defects.push("unterminated_stub");
  }
  for (const [index, row] of rows.entries()) {
    const first = [...row][0] ?? "";
    if (isCasedLower(first)) defects.push(`fragment_initial_sentence_${index}`);
    if (!balanced(row, "(", ")")) defects.push(`unbalanced_parentheses_${index}`);
    const quoteCount = [...row].filter(char => char === '"').length;
    if (quoteCount % 2 === 1) defects.push(`unbalanced_quotes_${index}`);
  }
  return { coherent: defects.length === 0, defects };
}
