import { clamp01 } from "./primitives.js";
import {
  GRAPH_QUALITY_CLASS_IDS,
  GRAPH_QUALITY_CLASS_REASON_IDS,
  GRAPH_QUALITY_REASON_IDS,
  type GraphQualityClassId
} from "./question-routing-ids.js";

export type GraphEdgeQualityClassId = GraphQualityClassId;

export interface GraphEdgeQualityInput {
  edgeId: string;
  relationId: string;
  subject: string;
  predicate: string;
  object: string;
  weight?: number;
  alpha?: number;
  forceClass?: string;
  sourceShardSupport?: number;
}

export interface GraphEdgeQuality {
  edgeId: string;
  classId: GraphEdgeQualityClassId;
  semanticQuality: number;
  predicateQuality: number;
  subjectQuality: number;
  objectQuality: number;
  labelCleanliness: number;
  fragmentScore: number;
  relationTypeUsefulness: number;
  categoryNavigationScore: number;
  entityCentralitySupport: number;
  sourceShardSupport: number;
  answerGrade: boolean;
  reasonIds: string[];
}

interface SurfaceProfile {
  text: string;
  normalized: string;
  symbols: string[];
  charCount: number;
  punctuationRatio: number;
  markupScore: number;
  boundaryDebrisScore: number;
  fragmentScore: number;
  cleanliness: number;
}

export function scoreGraphEdgeQuality(input: GraphEdgeQualityInput): GraphEdgeQuality {
  const subject = surfaceProfile(input.subject);
  const predicate = surfaceProfile(input.predicate);
  const object = surfaceProfile(input.object);
  const relationId = normalizeSurface(input.relationId);
  const relationUsefulness = relationTypeUsefulness(predicate, relationId);
  const categoryNavigationScore = categoryNavigation(predicate, relationId, object);
  const aliasScore = redirectOrAliasScore(predicate, relationId);
  const titleHintScore = titleOrProfileHintScore(predicate, relationId, subject, object);
  const predicateQuality = predicateQualityScore(predicate, relationUsefulness, categoryNavigationScore, aliasScore, titleHintScore);
  const subjectQuality = endpointQualityScore(subject, "subject");
  const objectQuality = endpointQualityScore(object, "object");
  const subjectSpecificity = endpointSpecificity(subject, "subject");
  const objectSpecificity = endpointSpecificity(object, "object");
  const labelCleanliness = clamp01((subject.cleanliness + predicate.cleanliness + object.cleanliness) / 3);
  const fragmentScore = clamp01(
    0.28 * subject.fragmentScore +
    0.34 * object.fragmentScore +
    0.28 * functionLikePredicateScore(predicate) +
    0.1 * Math.max(subject.boundaryDebrisScore, object.boundaryDebrisScore)
  );
  const sourceShardSupport = clamp01(input.sourceShardSupport ?? input.weight ?? input.alpha ?? 0.5);
  const entityCentralitySupport = clamp01(0.55 * endpointCentrality(subject) + 0.45 * endpointCentrality(object));
  const noisyMarkup = Math.max(subject.markupScore, predicate.markupScore, object.markupScore);
  let semanticQuality = clamp01(
    0.24 * predicateQuality +
    0.19 * subjectQuality +
    0.19 * objectQuality +
    0.08 * subjectSpecificity +
    0.04 * objectSpecificity +
    0.15 * relationUsefulness +
    0.1 * labelCleanliness +
    0.08 * entityCentralitySupport +
    0.05 * sourceShardSupport -
    0.34 * fragmentScore -
    0.2 * noisyMarkup -
    0.14 * categoryNavigationScore -
    0.12 * aliasScore -
    0.1 * titleHintScore
  );
  const reasonIds: string[] = [];
  if (predicate.symbols.length <= 1 && predicate.charCount <= 4) reasonIds.push(GRAPH_QUALITY_REASON_IDS.lowMassPredicate);
  if (subjectSpecificity < 0.42) reasonIds.push(GRAPH_QUALITY_REASON_IDS.lowInformationSubject);
  if (objectSpecificity < 0.32) reasonIds.push(GRAPH_QUALITY_REASON_IDS.lowInformationObject);
  if (functionLikePredicateScore(predicate) >= 0.72) reasonIds.push(GRAPH_QUALITY_REASON_IDS.functionPredicate);
  if (subject.fragmentScore >= 0.48) reasonIds.push(GRAPH_QUALITY_REASON_IDS.subjectFragment);
  if (object.fragmentScore >= 0.48) reasonIds.push(GRAPH_QUALITY_REASON_IDS.objectFragment);
  if (object.symbols.length > 10 || object.charCount > 120) reasonIds.push(GRAPH_QUALITY_REASON_IDS.longObject);
  if (noisyMarkup >= 0.16) reasonIds.push(GRAPH_QUALITY_REASON_IDS.markupDense);
  if (categoryNavigationScore >= 0.55) reasonIds.push(GRAPH_QUALITY_REASON_IDS.navigationShape);
  if (aliasScore >= 0.55) reasonIds.push(GRAPH_QUALITY_REASON_IDS.aliasShape);
  if (titleHintScore >= 0.55) reasonIds.push(GRAPH_QUALITY_REASON_IDS.profileHintShape);
  if (relationUsefulness >= 0.62 && fragmentScore < 0.36) reasonIds.push(GRAPH_QUALITY_REASON_IDS.semanticShape);
  let classId: GraphEdgeQualityClassId = GRAPH_QUALITY_CLASS_IDS.unknown;
  if (noisyMarkup >= 0.16 || labelCleanliness < 0.36 || (fragmentScore >= 0.72 && predicateQuality < 0.12)) classId = GRAPH_QUALITY_CLASS_IDS.noisyMarkup;
  else if (aliasScore >= 0.55) classId = GRAPH_QUALITY_CLASS_IDS.redirectAlias;
  else if (titleHintScore >= 0.55) classId = GRAPH_QUALITY_CLASS_IDS.titleHint;
  else if (categoryNavigationScore >= 0.55) classId = GRAPH_QUALITY_CLASS_IDS.catalogNavigation;
  else if (answerGradeShape({ semanticQuality, predicateQuality, objectQuality, subjectSpecificity, objectSpecificity, fragmentScore })) classId = GRAPH_QUALITY_CLASS_IDS.answerGrade;
  else if (fragmentScore >= 0.34 || predicateQuality < 0.42) classId = GRAPH_QUALITY_CLASS_IDS.weakFragment;
  if (classId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation) semanticQuality = Math.min(semanticQuality, 0.42);
  if (classId === GRAPH_QUALITY_CLASS_IDS.weakFragment) semanticQuality = Math.min(semanticQuality, 0.48);
  if (classId === GRAPH_QUALITY_CLASS_IDS.noisyMarkup) semanticQuality = Math.min(semanticQuality, 0.18);
  const answerGrade = classId === GRAPH_QUALITY_CLASS_IDS.answerGrade && semanticQuality >= 0.58;
  if (!answerGrade && classId !== GRAPH_QUALITY_CLASS_IDS.unknown) reasonIds.push(GRAPH_QUALITY_CLASS_REASON_IDS[classId]);
  if (answerGrade) reasonIds.push(GRAPH_QUALITY_CLASS_REASON_IDS[GRAPH_QUALITY_CLASS_IDS.answerGrade]);
  return {
    edgeId: input.edgeId,
    classId,
    semanticQuality,
    predicateQuality,
    subjectQuality,
    objectQuality,
    labelCleanliness,
    fragmentScore,
    relationTypeUsefulness: relationUsefulness,
    categoryNavigationScore,
    entityCentralitySupport,
    sourceShardSupport,
    answerGrade,
    reasonIds: unique(reasonIds)
  };
}

function answerGradeShape(input: { semanticQuality: number; predicateQuality: number; objectQuality: number; subjectSpecificity: number; objectSpecificity: number; fragmentScore: number }): boolean {
  return input.semanticQuality >= 0.58 &&
    input.predicateQuality >= 0.33 &&
    input.objectQuality >= 0.74 &&
    input.subjectSpecificity >= 0.42 &&
    input.objectSpecificity >= 0.32 &&
    input.fragmentScore < 0.24;
}

function predicateQualityScore(profile: SurfaceProfile, relationUsefulness: number, categoryNavigationScore: number, aliasScore: number, titleHintScore: number): number {
  if (!profile.symbols.length) return 0;
  const surfaceMass = Math.min(1, profile.symbols.length / 3);
  const charMass = Math.min(1, profile.charCount / 12);
  const lowFunction = functionLikePredicateScore(profile);
  return clamp01(
    0.28 * surfaceMass +
    0.2 * charMass +
    0.32 * relationUsefulness +
    0.2 * profile.cleanliness -
    0.44 * lowFunction -
    0.24 * categoryNavigationScore -
    0.22 * aliasScore -
    0.18 * titleHintScore
  );
}

function endpointQualityScore(profile: SurfaceProfile, role: "subject" | "object"): number {
  if (!profile.symbols.length) return 0;
  const idealUpper = role === "subject" ? 7 : 9;
  const symbolMass = profile.symbols.length <= idealUpper ? 1 : Math.max(0.15, 1 - (profile.symbols.length - idealUpper) / 12);
  const charMass = profile.charCount <= (role === "subject" ? 96 : 132) ? 1 : Math.max(0.12, 1 - (profile.charCount - (role === "subject" ? 96 : 132)) / 180);
  const compact = clamp01(0.58 * symbolMass + 0.42 * charMass);
  return clamp01(0.5 * compact + 0.35 * profile.cleanliness + 0.15 * endpointCentrality(profile) - 0.42 * profile.fragmentScore);
}

function endpointSpecificity(profile: SurfaceProfile, role: "subject" | "object"): number {
  if (!profile.symbols.length) return 0;
  const alphabeticLengths = profile.symbols.filter(symbol => hasLetter(symbol)).map(symbol => [...symbol].length);
  const numericLengths = profile.symbols.filter(symbol => symbol.split("").every(isDigit)).map(symbol => [...symbol].length);
  const maxAlphabetic = Math.max(0, ...alphabeticLengths);
  const maxNumeric = Math.max(0, ...numericLengths);
  let score = 0.12;
  if (maxAlphabetic >= 8) score = 0.9;
  else if (maxAlphabetic >= 6) score = 0.82;
  else if (maxAlphabetic >= 5) score = 0.68;
  else if (profile.symbols.length >= 2 && maxAlphabetic >= 4) score = 0.6;
  else if (profile.symbols.length >= 2 && maxAlphabetic >= 3) score = 0.45;
  else if (role === "object" && maxNumeric >= 2) score = 0.52;
  if (profile.symbols.length >= 3 && maxAlphabetic >= 4) score += 0.08;
  if (profile.fragmentScore >= 0.34) score -= 0.18;
  if (profile.markupScore >= 0.12) score -= 0.16;
  return clamp01(score);
}

function relationTypeUsefulness(predicate: SurfaceProfile, relationId: string): number {
  const relationSymbols = splitSurfaceSymbols(relationId);
  const predicateMass = predicate.symbols.length;
  const relationMass = relationSymbols.length;
  const generatedIdPenalty = relationId.includes("relation") && relationSymbols.some(symbol => symbol.length >= 16) ? 0.22 : 0;
  const semanticSeparatorBonus = relationId.includes(".") || relationId.includes(":") || relationId.includes("_") ? 0.12 : 0;
  const mass = Math.max(predicateMass, relationMass);
  return clamp01(0.18 + Math.min(0.52, mass / 6) + semanticSeparatorBonus + predicate.cleanliness * 0.18 - generatedIdPenalty - functionLikePredicateScore(predicate) * 0.38);
}

function categoryNavigation(predicate: SurfaceProfile, relationId: string, object: SurfaceProfile): number {
  const joined = `${predicate.normalized} ${relationId} ${object.normalized}`;
  const relationSymbols = splitSurfaceSymbols(relationId);
  const namespaceLike = /(^|[\s._:/#-])[\p{L}\p{N}]{2,24}[:/][\p{L}\p{N}]/u.test(joined) ? 0.42 : 0;
  const denseStructuralSeparators = (joined.match(/[.:/#_|-]/gu)?.length ?? 0) / Math.max(1, joined.length);
  const predicateStructural = /[.:/#_|-]/u.test(predicate.text) ? 0.36 : 0;
  const relationStructured = relationSymbols.length >= 2 && /[.:/#_|-]/u.test(relationId) ? 0.14 : 0;
  const objectClassifierShape = object.symbols.length >= 3 && object.symbols.length <= 9 && endpointCentrality(object) >= 0.54 ? 0.24 : 0;
  const structuralMass = objectClassifierShape > 0 && predicateStructural > 0 ? Math.min(0.24, denseStructuralSeparators * 3.2) + relationStructured : 0;
  const listShape = predicateStructural > 0 && relationStructured > 0 && objectClassifierShape > 0 ? 0.18 : 0;
  return clamp01(namespaceLike + predicateStructural + structuralMass + objectClassifierShape + listShape);
}

function redirectOrAliasScore(predicate: SurfaceProfile, relationId: string): number {
  const relationSymbols = splitSurfaceSymbols(relationId);
  const predicateLowMass = predicate.symbols.length <= 2 && predicate.charCount <= 14 ? 0.22 : 0;
  const relationLowMass = relationSymbols.length <= 2 && relationId.length <= 24 ? 0.18 : 0;
  const structuralMarkerMass = (relationId.match(/[:=#>|]/gu)?.length ?? 0) > 0 ? 0.22 : 0;
  return clamp01(predicateLowMass + relationLowMass + structuralMarkerMass - predicate.cleanliness * 0.12);
}

function titleOrProfileHintScore(predicate: SurfaceProfile, relationId: string, subject: SurfaceProfile, object: SurfaceProfile): number {
  const joined = `${predicate.normalized} ${relationId} ${subject.normalized} ${object.normalized}`;
  const endpointOverlap = surfaceSymbolOverlap(subject.symbols, object.symbols);
  const compactPredicate = predicate.symbols.length <= 2 && predicate.charCount <= 18 ? 0.22 : 0;
  const markupHint = /[:/#]|[\[\]{}<>]/u.test(joined) ? 0.24 : 0;
  const endpointShort = subject.symbols.length <= 4 && object.symbols.length <= 8 ? 0.14 : 0;
  return clamp01(endpointOverlap * 0.42 + compactPredicate + markupHint + endpointShort);
}

function functionLikePredicateScore(profile: SurfaceProfile): number {
  if (!profile.symbols.length) return 1;
  const symbolCount = profile.symbols.length;
  const charCount = profile.charCount;
  const compact = symbolCount <= 1 ? (charCount <= 3 ? 1 : charCount <= 5 ? 0.38 : charCount <= 8 ? 0.24 : 0.14) : symbolCount === 2 && charCount <= 8 ? 0.24 : 0.08;
  const vowelThinness = alphabeticVowelRatio(profile.normalized) < 0.18 && charCount <= 6 ? 0.18 : 0;
  return clamp01(compact + vowelThinness - profile.markupScore * 0.2);
}

function endpointCentrality(profile: SurfaceProfile): number {
  if (!profile.symbols.length) return 0;
  const middle = profile.symbols.length >= 2 && profile.symbols.length <= 6 ? 0.82 : profile.symbols.length === 1 ? 0.56 : 0.4;
  const clean = profile.cleanliness;
  return clamp01(0.6 * middle + 0.4 * clean);
}

function surfaceProfile(value: string): SurfaceProfile {
  const text = collapseWhitespace(value.normalize("NFKC"));
  const normalized = normalizeSurface(text);
  const symbols = splitSurfaceSymbols(normalized);
  const chars = [...text];
  const punctuation = chars.filter(isPunctuationLike).length;
  const punctuationRatio = punctuation / Math.max(1, chars.length);
  const markupScore = markupDebrisScore(text);
  const boundaryDebrisScore = boundaryDebris(text);
  const fragmentScore = clamp01(
    (symbols.length > 11 ? Math.min(0.5, (symbols.length - 10) / 18) : 0) +
    (chars.length > 128 ? Math.min(0.38, (chars.length - 128) / 220) : 0) +
    punctuationRatio * 1.6 +
    boundaryDebrisScore * 0.72 +
    markupScore * 0.86
  );
  const cleanliness = clamp01(1 - markupScore * 0.68 - punctuationRatio * 1.35 - boundaryDebrisScore * 0.58 - (symbols.length ? 0 : 0.7));
  return { text, normalized, symbols, charCount: chars.length, punctuationRatio, markupScore, boundaryDebrisScore, fragmentScore, cleanliness };
}

function normalizeSurface(value: string): string {
  return collapseWhitespace(value.normalize("NFKC").toLocaleLowerCase());
}

function splitSurfaceSymbols(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of value) {
    if (isSymbolChar(char)) {
      current += char;
      continue;
    }
    if (current) out.push(current);
    current = "";
  }
  if (current) out.push(current);
  return out.filter(Boolean);
}

function surfaceSymbolOverlap(left: readonly string[], right: readonly string[]): number {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  let shared = 0;
  for (const symbol of left) if (rightSet.has(symbol)) shared++;
  return shared / Math.max(1, Math.min(left.length, right.length));
}

function collapseWhitespace(value: string): string {
  let out = "";
  let pending = false;
  for (const char of value) {
    if (isWhitespace(char)) {
      pending = Boolean(out);
      continue;
    }
    if (pending) out += " ";
    pending = false;
    out += char;
  }
  return out.trim();
}

function markupDebrisScore(value: string): number {
  let score = 0;
  const pairs: Array<[string, string]> = [["{", "}"], ["[", "]"], ["<", ">"]];
  for (const [left, right] of pairs) {
    const leftCount = countChar(value, left);
    const rightCount = countChar(value, right);
    score += Math.min(0.34, (leftCount + rightCount) / Math.max(10, [...value].length));
    if (Math.abs(leftCount - rightCount) > 1) score += 0.16;
  }
  if (value.includes("://")) score += 0.28;
  if (value.includes("&") && value.includes(";")) score += 0.14;
  return clamp01(score);
}

function boundaryDebris(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 1;
  const first = trimmed[0] ?? "";
  const last = trimmed[trimmed.length - 1] ?? "";
  let score = 0;
  if (isPunctuationLike(first)) score += 0.26;
  if (isPunctuationLike(last) && last !== "." && last !== "?" && last !== "!") score += 0.2;
  if (trimmed.includes("  ")) score += 0.1;
  if (trimmed.includes("...")) score += 0.18;
  return clamp01(score);
}

function alphabeticVowelRatio(value: string): number {
  let letters = 0;
  let vowels = 0;
  for (const char of value) {
    if (!isLetter(char)) continue;
    letters++;
    if (char === "a" || char === "e" || char === "i" || char === "o" || char === "u") vowels++;
  }
  return vowels / Math.max(1, letters);
}

function countChar(value: string, target: string): number {
  let count = 0;
  for (const char of value) if (char === target) count++;
  return count;
}

function isSymbolChar(char: string): boolean {
  return isLetter(char) || isDigit(char);
}

function isLetter(char: string): boolean {
  if (!char) return false;
  return char.toLocaleLowerCase() !== char.toLocaleUpperCase();
}

function hasLetter(value: string): boolean {
  for (const char of value) if (isLetter(char)) return true;
  return false;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r" || char === "\v" || char === "\f";
}

function isPunctuationLike(char: string): boolean {
  if (!char) return false;
  if (isSymbolChar(char) || isWhitespace(char)) return false;
  return true;
}

function unique(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) if (value && !out.includes(value)) out.push(value);
  return out;
}
