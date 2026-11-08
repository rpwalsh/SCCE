import { canonical } from '../../protocol.mjs';

const prompts = {
  en: { single: [(a,b) => `What is ${a} plus ${b}?`, (a,b) => `Subtract ${b} from ${a}.`, (a,b) => `Multiply ${a} by ${b}.`, (a,b) => `Divide ${a} by ${b}.`],
    multi: [(a,b,c) => `Start with ${a}. Add ${b}, then multiply the result by ${c}.`, (a,b,c) => `Start with ${a}. Subtract ${b}, then multiply the result by ${c}.`, (a,b,c) => `Multiply ${a} by ${b}, then add ${c} to the result.`, (a,b,c) => `Divide ${a} by ${b}, then subtract ${c} from the result.`],
    response: 'Return only one base-ten integer in ASCII digits, with an optional sign. No words, equations, units, or additional numbers.' },
  ru: { single: [(a,b) => `Сколько получится, если к ${a} прибавить ${b}?`, (a,b) => `Вычти ${b} из ${a}.`, (a,b) => `Умножь ${a} на ${b}.`, (a,b) => `Раздели ${a} на ${b}.`],
    multi: [(a,b,c) => `Возьми число ${a}. Прибавь ${b}, затем умножь результат на ${c}.`, (a,b,c) => `Возьми число ${a}. Вычти ${b}, затем умножь результат на ${c}.`, (a,b,c) => `Умножь ${a} на ${b}, затем прибавь к результату ${c}.`, (a,b,c) => `Раздели ${a} на ${b}, затем вычти из результата ${c}.`],
    response: 'Верни только одно целое число десятичными цифрами ASCII, при необходимости со знаком. Без слов, уравнений, единиц измерения и дополнительных чисел.' },
  es: { single: [(a,b) => `¿Cuánto es ${a} más ${b}?`, (a,b) => `Resta ${b} de ${a}.`, (a,b) => `Multiplica ${a} por ${b}.`, (a,b) => `Divide ${a} entre ${b}.`],
    multi: [(a,b,c) => `Empieza con ${a}. Suma ${b} y después multiplica el resultado por ${c}.`, (a,b,c) => `Empieza con ${a}. Resta ${b} y después multiplica el resultado por ${c}.`, (a,b,c) => `Multiplica ${a} por ${b} y después suma ${c} al resultado.`, (a,b,c) => `Divide ${a} entre ${b} y después resta ${c} del resultado.`],
    response: 'Devuelve solo un número entero en cifras decimales ASCII, con signo opcional. Sin palabras, ecuaciones, unidades ni números adicionales.' },
  ca: { single: [(a,b) => `Quant fan ${a} més ${b}?`, (a,b) => `Resta ${b} de ${a}.`, (a,b) => `Multiplica ${a} per ${b}.`, (a,b) => `Divideix ${a} entre ${b}.`],
    multi: [(a,b,c) => `Comença amb ${a}. Suma-hi ${b} i després multiplica el resultat per ${c}.`, (a,b,c) => `Comença amb ${a}. Resta-hi ${b} i després multiplica el resultat per ${c}.`, (a,b,c) => `Multiplica ${a} per ${b} i després suma ${c} al resultat.`, (a,b,c) => `Divideix ${a} entre ${b} i després resta ${c} del resultat.`],
    response: 'Retorna només un nombre enter en xifres decimals ASCII, amb signe opcional. Sense paraules, equacions, unitats ni nombres addicionals.' }
};

export function arithmeticCase(cell, index, rng, options = {}) {
  const locale = prompts[cell.language];
  if (!locale) throw new Error(`Missing arithmetic locale provider: ${cell.language}`);
  const operation = rng.integer(4), multi = index % 2 === 1;
  let a = BigInt(2 + rng.integer(9998));
  const b = BigInt(2 + rng.integer(9998)), c = BigInt(2 + rng.integer(9998));
  if (operation === 3) a *= b;
  const expected = multi
    ? [() => (a+b)*c, () => (a-b)*c, () => a*b+c, () => a/b-c][operation]()
    : [() => a+b, () => a-b, () => a*b, () => a/b][operation]();
  const contract = { schema: 'scce.blind-native-task.v1', operation: 'turn', maxPublicAttempts: options.attempts ?? 1,
    writablePaths: [], publicChecks: [], approvals: [], responseInstruction: locale.response };
  return { public: { outputContract: canonical(contract), steps: [{ prompt: (multi ? locale.multi : locale.single)[operation](a,b,c), sources: [], files: {} }] },
    private: { kind: 'semantic', answerType: 'exact_integer', expected: [String(expected)], family: multi ? 'unitless_multistep_arithmetic' : 'unitless_single_operation' } };
}
