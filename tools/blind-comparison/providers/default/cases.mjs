import { createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, hash, writeJson } from '../../protocol.mjs';
import { nativeFiles, expectedReads, NATIVE_LANGUAGES, nativePublicDeclarations } from './native-fixtures.mjs';
import { numericFiles, numericExpected, nativePublicDeclarations as numericPublicDeclarations } from './numeric-fixtures.mjs';
import { nativeValidationPermission } from './native-validation-permission.mjs';
import { sha256Text } from '../../../sealed-eval/harness/lib/util.mjs';

export const CATEGORY_GROUPS = { chat: 'chat', creative: 'creative', corpus_facts: 'corpus_facts', learning_updates: 'learning_updates', code_repair_stateful: 'code', code_generation_stateful: 'code', code_repair_numeric: 'code', code_generation_numeric: 'code', agentic_autonomous: 'agentic', agentic_given_plan: 'agentic' };
export function randomStream(seed, domain) {
  let counter = 0;
  return { hex: () => createHmac('sha256', seed).update(`${domain}\0${counter++}`).digest('hex'), integer(limit) { return Number(BigInt(`0x${this.hex().slice(0, 12)}`) % BigInt(limit)); } };
}
export function defaultInventory(capabilities, admitted = []) {
  const formal = new Set(capabilities.formalLanguages), natural = new Set(capabilities.naturalLanguages);
  for (const manifest of admitted) {
    for (const row of manifest.formal ?? []) if (row.language) formal.add(row.language);
    for (const lang of manifest.formalLanguages ?? []) formal.add(lang);
    for (const lang of manifest.naturalLanguages ?? []) natural.add(lang);
    for (const locale of manifest.sourceLocales ?? []) natural.add(typeof locale === 'string' ? locale : locale.language);
    for (const source of manifest.sources ?? []) {
      if (source.public !== true) throw new Error('Admitted inventory may contain only explicitly public sources');
      if (source.formalLanguage) formal.add(source.formalLanguage);
      if (source.naturalLanguage) natural.add(source.naturalLanguage);
    }
  }
  const cells = [];
  for (const language of [...natural].sort()) for (const category of ['chat', 'creative', 'corpus_facts', 'learning_updates', 'agentic_autonomous', 'agentic_given_plan']) cells.push({ category, language, grading: ['chat', 'creative'].includes(category) ? 'human' : category === 'agentic_autonomous' ? 'native' : 'semantic' });
  for (const language of [...formal].sort()) for (const category of ['code_repair_stateful', 'code_generation_stateful', 'code_repair_numeric', 'code_generation_numeric']) cells.push({ category, language, grading: 'native' });
  const priorFormalAdmission = [...formal].sort().map(language => ({ language, reportedCanonicalModels: admitted.flatMap(m => m.formal ?? []).filter(row => row.language === language).reduce((sum, row) => sum + Number(row.models ?? 0), 0), status: admitted.some(m => (m.formal ?? []).some(row => row.language === language && row.models > 0)) ? 'reported_admitted_models_not_proven_task_capability' : 'no_prior_canonical_admission_reported_campaign_source_preparation_still_required' }));
  return { schema: 'scce.blind-default-inventory.v1', formalLanguages: [...formal].sort(), naturalLanguages: [...natural].sort(), priorFormalAdmission, categoryGroups: CATEGORY_GROUPS, admittedSourceCoverage: admitted.map(m => ({ schema: m.schema, formal: m.formal ?? [], naturalScriptIdentities: m.natural ?? [], sourceLocales: m.sourceLocales ?? [] })), capabilityEvidence: 'Task capability is unproven until private validation or independent ballots; source/script identity alone proves no task capability or locale.', cells };
}
export function coverageGaps(inventory, tools) {
  const gaps = [];
  for (const language of inventory.formalLanguages) {
    if (!NATIVE_LANGUAGES.includes(language)) gaps.push({ language, kind: 'missing_native_provider' });
    else if (!tools[language]?.available) gaps.push({ language, kind: 'missing_native_toolchain' });
  }
  for (const language of inventory.naturalLanguages) if (!Object.hasOwn(locales, language)) gaps.push({ language, kind: 'missing_locale_provider' });
  return gaps;
}
const locales = {
  en: {
    record: (name, desk, city, extension) => `${name} works at desk ${desk} in ${city}. The internal telephone extension for ${name} is ${extension}.`,
    question: [name => `Which internal extension reaches ${name}?`, name => `I need to telephone ${name}; give only the extension.`, name => `What number should I dial inside the office to contact ${name}?`, name => `Look up the office phone entry for ${name}. Return the extension value alone.`, name => `For ${name}, which extension is listed in the directory?`, name => `How can I reach ${name} on the internal telephone system? Give just the listed extension.`],
    response: 'Give only the exact extension value when the public directory supports it. Otherwise abstain. Do not guess.',
    chat: (place, object) => [`We share ${place} with four neighbors and have only one ${object}. Help us agree on a fair, practical way to organize its use. Explain the tradeoffs without inventing facts about us.`, `Two neighbors work nights and cannot attend a daytime meeting. Revise your advice to include them, while keeping the arrangement simple. Refer to our previous situation.`],
    creative: (a, b, place, object) => [`Write a short scene in ${place}: ${a} has misplaced a borrowed ${object}, while ${b} needs it soon. Give each character a different motive. Use concrete action and dialogue. Do not finish the disagreement yet.`, `Continue the same scene. Reveal a plausible misunderstanding, preserve both motives, and end with a difficult but credible choice. Do not replace the story with an explanation.`],
    repair: (language, target) => `Repair ${target} in ${language}. Preserve the declared callable names and interfaces. The public native checks show the required behavior; fix the implementation, not the tests or driver. The specification applies to arbitrary unseen keys/inputs, not only the examples.`,
    generation: (language, target) => `Create ${target} in ${language}, implementing the public callable specification and the existing immutable native driver. You may add new local source/test files, but add no external dependencies and preserve every existing public file. It must work on arbitrary unseen keys/inputs, not just the examples.`,
    action: 'Use the available public workspace tools to inspect the input, derive a report, write report.json and run the public check. Decide and execute the steps yourself; no execution plan is supplied. Never modify the input or check.',
    given: 'Execute the supplied dependency-ordered local goal through the native executive. Report success only after the real build and test have succeeded.'
  },
  ru: {
    record: (name, desk, city, extension) => `${name} работает за столом ${desk} в ${city}. Внутренний телефонный номер для ${name}: ${extension}.`,
    question: [name => `Какой внутренний номер указан для ${name}?`, name => `Мне нужно позвонить ${name} внутри офиса. Назови только добавочный номер.`, name => `Что набрать на внутреннем телефоне, чтобы связаться с ${name}?`, name => `Найди телефонную запись ${name} и верни только значение внутреннего номера.`, name => `По какому добавочному номеру доступен ${name} согласно справочнику?`, name => `Как связаться с ${name} по офисной телефонной системе? Укажи только номер из источника.`],
    response: 'Верни только точное значение внутреннего номера, если оно подтверждено общедоступным справочником. Иначе воздержись от ответа. Не угадывай.',
    chat: (place, object) => [`Четверо соседей совместно пользуются ${place}, но у них только один предмет ${object}. Предложи справедливый и практичный порядок пользования. Объясни компромиссы и не выдумывай факты о соседях.`, `Двое соседей работают по ночам и не могут прийти на дневное собрание. Пересмотри совет с учётом их участия, сохрани простоту правил и связь с предыдущей ситуацией.`],
    creative: (a, b, place, object) => [`Напиши короткую сцену в месте ${place}: ${a} потерял одолженный предмет ${object}, а ${b} он скоро понадобится. Дай героям разные мотивы, используй конкретные действия и диалог. Пока не разрешай конфликт.`, `Продолжи ту же сцену. Раскрой правдоподобное недоразумение, сохрани оба мотива и заверши трудным, но убедительным выбором. Не заменяй историю объяснением.`],
    repair: (language, target) => `Исправь реализацию ${target} на ${language}. Сохрани имена и интерфейсы объявленных функций. Требуемое поведение показано в открытых нативных проверках; изменяй реализацию, а не проверки или драйвер. Спецификация действует для любых новых ключей и входов, а не только для примеров.`,
    generation: (language, target) => `Создай ${target} на ${language} согласно открытой спецификации функций и существующему неизменяемому нативному драйверу. Можно добавлять новые локальные исходники и тесты, но не внешние зависимости; сохрани все существующие открытые файлы. Реализация должна работать на новых ключах и входах, а не только на примерах.`,
    action: 'С помощью доступных открытых инструментов рабочей папки изучи входные данные, вычисли отчёт, запиши report.json и выполни открытую проверку. Самостоятельно выбери и выполни шаги: готового плана нет. Не изменяй входные данные и проверку.',
    given: 'Выполни предоставленную локальную цель с зависимыми задачами через нативный исполнитель. Сообщи об успехе только после настоящей успешной сборки и проверки.'
  },
  es: {
    record: (name, desk, city, extension) => `${name} trabaja en el puesto ${desk}, en ${city}. La extensión telefónica interna de ${name} es ${extension}.`,
    question: [name => `¿Qué extensión interna corresponde a ${name}?`, name => `Necesito llamar a ${name} dentro de la oficina. Indica solo la extensión.`, name => `¿Qué número debo marcar en el teléfono interno para contactar con ${name}?`, name => `Busca la ficha telefónica de ${name} y devuelve únicamente su extensión.`, name => `Según el directorio, ¿en qué extensión se encuentra ${name}?`, name => `¿Cómo puedo comunicarme con ${name} por teléfono interno? Da solo el número indicado.`],
    response: 'Devuelve únicamente el valor exacto de la extensión si está respaldado por el directorio público. En caso contrario, abstente. No adivines.',
    chat: (place, object) => [`Cuatro vecinos comparten ${place}, pero solo disponen de un objeto ${object}. Propón una forma justa y práctica de organizar su uso. Explica las dificultades sin inventar datos sobre los vecinos.`, 'Dos vecinos trabajan de noche y no pueden asistir a una reunión diurna. Revisa el consejo para incluirlos y mantén un acuerdo sencillo y coherente con la situación anterior.'],
    creative: (a, b, place, object) => [`Escribe una escena breve en ${place}: ${a} ha perdido un objeto prestado, ${object}, y ${b} lo necesita pronto. Dales motivos distintos y usa acciones concretas y diálogo. No resuelvas todavía el conflicto.`, 'Continúa la misma escena. Revela un malentendido plausible, conserva los motivos de ambos personajes y termina con una decisión difícil pero creíble. No sustituyas la historia por una explicación.'],
    action: 'Usa las herramientas públicas del espacio de trabajo para examinar los datos, calcular un informe, escribir report.json y ejecutar la comprobación pública. Decide y ejecuta los pasos; no hay un plan preparado. No cambies los datos ni la comprobación.',
    given: 'Ejecuta el objetivo local proporcionado mediante el ejecutor nativo y respeta las dependencias. Declara el éxito solo después de una compilación y una prueba reales y satisfactorias.'
  },
  ca: {
    record: (name, desk, city, extension) => `${name} treballa al lloc ${desk}, a ${city}. L'extensió telefònica interna de ${name} és ${extension}.`,
    question: [name => `Quina extensió interna correspon a ${name}?`, name => `He de trucar a ${name} dins de l'oficina. Indica només l'extensió.`, name => `Quin número he de marcar al telèfon intern per contactar amb ${name}?`, name => `Cerca la fitxa telefònica de ${name} i retorna únicament l'extensió.`, name => `Segons el directori, a quina extensió es pot trobar ${name}?`, name => `Com puc parlar amb ${name} per telèfon intern? Dona només el número indicat.`],
    response: 'Retorna només el valor exacte de l’extensió si el directori públic el confirma. Altrament, abstén-te de respondre. No facis suposicions.',
    chat: (place, object) => [`Quatre veïns comparteixen ${place}, però només disposen d'un objecte ${object}. Proposa una manera justa i pràctica d'organitzar-ne l'ús. Explica els compromisos sense inventar dades sobre els veïns.`, 'Dos veïns treballen de nit i no poden assistir a una reunió diürna. Revisa el consell per incloure’ls, mantenint un acord senzill i coherent amb la situació anterior.'],
    creative: (a, b, place, object) => [`Escriu una escena breu a ${place}: ${a} ha perdut un objecte prestat, ${object}, i ${b} el necessita aviat. Dona’ls motius diferents i fes servir accions concretes i diàleg. Encara no resolguis el conflicte.`, 'Continua la mateixa escena. Revela un malentès plausible, conserva els motius de tots dos personatges i acaba amb una decisió difícil però creïble. No substitueixis la història per una explicació.'],
    action: 'Fes servir les eines públiques de l’espai de treball per examinar les dades, calcular un informe, escriure report.json i executar la comprovació pública. Decideix i executa els passos; no hi ha cap pla preparat. No canviïs les dades ni la comprovació.',
    given: 'Executa l’objectiu local proporcionat mitjançant l’executor natiu i respecta les dependències. Declara l’èxit només després d’una compilació i una prova reals i satisfactòries.'
  }
};
function baseContract(operation, options, extra = {}) {
  return { schema: 'scce.blind-native-task.v1', operation, maxPublicAttempts: options.attempts, writablePaths: [], publicChecks: [], approvals: [], ...extra };
}
function admission() { return { sourceClass: 'owner_local', intendedUse: 'direct_evidence', promotionAuthority: 'owner' }; }
function trust(id) { return { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: `test-authored:${id}`, accessScope: 'owner_private', licenseStatus: 'owner_authorized' }; }
function identifier(rng, prefix) { return `${prefix}_${rng.hex().slice(0, 10)}`; }
function extension(rng) { return String(10000000 + rng.integer(90000000)); }
async function privateNative(privateRoot, id, vectors) {
  const dir = path.join(privateRoot, 'validators', id); await mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, 'vectors.json'), vectors);
  await writeFile(path.join(dir, 'check.mjs'), "import {checkVectors} from './native-runner.mjs';await checkVectors('.sealed-vectors.json');\n", { flag: 'wx' });
  return { kind: 'native', argv: ['{node}', '.sealed-check.mjs'], files: [{ path: `validators/${id}/check.mjs`, target: '.sealed-check.mjs' }, { path: `validators/${id}/vectors.json`, target: '.sealed-vectors.json' }] };
}
async function codeCase(cell, index, rng, options, id) {
  const stateful = cell.category.endsWith('stateful'), repair = cell.category.startsWith('code_repair');
  const names = { write: identifier(rng, 'f'), read: identifier(rng, 'g'), remove: identifier(rng, 'h') }, fn = identifier(rng, 'q');
  const k = identifier(rng, 'public'), k2 = identifier(rng, 'public'), v = extension(rng), v2 = extension(rng);
  const publicVectors = stateful ? [[['W', k, v], ['R', k], ['W', k, v2], ['R', k], ['W', k2, v], ['D', k], ['R', k], ['R', k2]]] : [[['F', 10, 0, 5], ['F', -3, 0, 5], ['F', 3, 0, 5]]];
  const defect = ['lost_write', 'lost_delete', 'missing_value'][index % 3];
  const fixture = stateful ? await nativeFiles({ language: cell.language, names, tools: options.tools, repair, defect, publicVectors }) : await numericFiles({ language: cell.language, name: fn, tools: options.tools, repair, publicVectors });
  if (!fixture) throw new Error(`Missing native provider: ${cell.language}`);
  const behaviorSpec = stateful ? `${names.write}(key, value); ${names.read}(key); ${names.remove}(key). Keys and values are opaque UTF-8 strings without tabs/newlines. Store the latest value independently for each key; reads of absent keys return "~"; removal affects only the named key. ${cell.language === 'rust' ? 'The Rust API takes the shared HashMap reference as the first parameter.' : ''}\n${names.write}(${JSON.stringify(k)},${JSON.stringify(v)}); ${names.read}(${JSON.stringify(k)}) => ${JSON.stringify(v)}\n${names.write}(${JSON.stringify(k)},${JSON.stringify(v2)}); ${names.read}(${JSON.stringify(k)}) => ${JSON.stringify(v2)}\n${names.remove}(${JSON.stringify(k)}); ${names.read}(${JSON.stringify(k)}) => "~"` : `${fn}(value, lower, upper) returns value bounded inclusively by lower and upper. Integer inputs satisfy lower <= upper.\n${fn}(10,0,5) => 5\n${fn}(-3,0,5) => 0\n${fn}(3,0,5) => 3`;
  const spec = `${behaviorSpec}\n${stateful ? nativePublicDeclarations(cell.language, names) : numericPublicDeclarations(cell.language, fn)}`;
  const privateRng = randomStream(options.seed, `${id}:private-native`), vectors = [];
  for (let n = 0; n < options.hiddenVectors; n++) {
    if (stateful) {
      const prefix = ['ключ', '键', '__proto__', 'constructor'][n % 4];
      const a = prefix + (n % 4 < 2 ? privateRng.hex().slice(0, 14) : ''), b = identifier(privateRng, 'unseen'), x = extension(privateRng), y = extension(privateRng);
      const operations = [['R', a], ['W', a, x], ['W', b, y], ['R', a], ['R', b], ['W', a, y], ['R', a], ['D', b], ['R', b], ['R', a], ['D', a], ['R', a]];
      vectors.push({ operations, expected: expectedReads(operations) });
    } else {
      const lower = privateRng.integer(20000) - 10000, upper = lower + 1 + privateRng.integer(20000);
      const operations = [['F', lower - 1, lower, upper], ['F', upper + 1, lower, upper], ['F', lower, lower, upper], ['F', upper, lower, upper], ['F', Math.floor((lower + upper) / 2), lower, upper]];
      vectors.push({ operations, expected: numericExpected(operations) });
    }
  }
  const checks = [{ argv: ['{node}', 'public-check.mjs'] }];
  const policy = { schemaVersion: 'scce.patch-validation-policy.v1', id: 'blind-public-native.v1', commands: [{ executable: options.tools.node.path, argv: ['public-check.mjs'], checkIds: ['compiler', 'typecheck', 'tests'] }], timeoutMs: options.budgets.timeMs, maxOutputBytes: options.budgets.outputBytes, maxWorkspaceFiles: Object.keys(fixture.files).length + 32, maxWorkspaceBytes: options.budgets.artifactBytes, environment: {} };
  const contract = baseContract(repair ? 'code_repair' : 'code_generation', options, { writablePaths: [fixture.target], targetPaths: [fixture.target], publicChecks: checks, ...(repair ? { validationPolicy: policy } : { programMode: 'verified_artifacts', allowNewFiles: true, approvals: ['process.build_test'], nativeValidationPermission: nativeValidationPermission({language:cell.language,target:fixture.target,tools:options.tools,protectedPaths:[...Object.keys(fixture.files),'specification.txt'],maxFiles:policy.maxWorkspaceFiles,maxBytes:options.budgets.artifactBytes}) }), prepareWorkspace: true });
  const requestLocale = index % 2 ? 'ru' : 'en';
  return { public: { outputContract: canonical(contract), steps: [{ prompt: `${repair ? locales[requestLocale].repair(cell.language, fixture.target) : locales[requestLocale].generation(cell.language, fixture.target)}\n${spec}`, sources: [], files: { ...fixture.files, 'specification.txt': spec } }] }, private: { ...await privateNative(options.privateRoot, id, vectors), family: stateful ? `stateful_${repair ? defect : 'generation'}` : 'numeric_piecewise', requestLocale, hiddenKeyCount: stateful ? vectors.length * 2 : 0 } };
}
async function naturalCase(cell, index, rng, options, id) {
  const locale = locales[cell.language];
  if (!locale) throw new Error(`Missing locale provider: ${cell.language}`);
  const name = identifier(rng, 'Person'), absent = identifier(rng, 'Person'), desk = identifier(rng, 'Desk'), city = identifier(rng, 'Place'), old = extension(rng), updated = extension(rng), sourceId = identifier(rng, 'source');
  const source = locale.record(name, desk, city, old);
  if (cell.category === 'corpus_facts' || cell.category === 'learning_updates') {
    const negative = cell.category === 'corpus_facts' && index % 2 === 1;
    const prompt = locale.question[rng.integer(locale.question.length)](negative ? absent : name);
    const contract = baseContract(cell.category === 'learning_updates' ? 'learning_update' : 'turn', options, { answerMode: 'answer_or_abstain', requestedAuthority: 'factual', sourceAdmission: admission(), sourceTrust: trust(id), responseInstruction: locale.response });
    const steps = [{ prompt, sources: [{ id: sourceId, text: source }], files: {} }];
    const expected = [negative ? { status: 'abstained', answer: null } : { status: 'answered', answer: old }];
    if (cell.category === 'learning_updates') {
      steps.push({ prompt: locale.question[(index + 1) % locale.question.length](name), sources: [{ id: sourceId, text: locale.record(name, desk, city, updated) }], files: {} });
      expected.push({ status: 'answered', answer: updated });
    }
    return { public: { outputContract: canonical(contract), steps }, private: { kind: 'semantic', expected, family: negative ? 'unsupported_query' : cell.category === 'learning_updates' ? 'live_source_correction' : 'supported_private_paraphrase' } };
  }
  if (['chat', 'creative'].includes(cell.category)) {
    const prompts = cell.category === 'chat' ? locale.chat(city, desk) : locale.creative(name, absent, city, desk);
    const contract = baseContract('turn', options, { ...(cell.category === 'creative' ? { requestedAuthority: 'creative' } : {}) });
    return { public: { outputContract: canonical(contract), steps: prompts.map(prompt => ({ prompt, sources: [], files: {} })) }, private: { kind: 'human', dimensions: ['task_fulfillment', 'continuity', 'coherence', 'specificity'], rubric: 'Judge the complete two-turn exchange independently. Score each dimension 0–4, disclose conflicts or identity guesses, then choose A/B/tie. For chat assess actionable advice and respect for changed constraints; for creative assess motives, concrete action/dialogue, continuity and a credible ending. Do not infer quality from length or system identity. No automated quality rating is authorized.', family: cell.category === 'chat' ? 'multiturn_changed_constraints' : 'multiturn_open_ended_story' } };
  }
  if (cell.category === 'agentic_given_plan') {
    const text = `import assert from 'node:assert/strict';const rows=${canonical([rng.integer(100), rng.integer(100), rng.integer(100)])};assert.equal([...rows].sort((a,b)=>a-b)[0],Math.min(...rows));console.log('public task executed');`;
    const artifact = { artifactId: `artifact.${id}`, path: 'main.mjs', content: text, contentHash: `sha256_${sha256Text(text)}`, mediaType: 'text/javascript', role: 'source' };
    const goal = { schema: 'scce.local_executive_goal.v1', episodeId: `episode.${id}`, goalId: `goal.${id}`, tasks: [{ id: `task.${id}`, dependencyTaskIds: [], construct: { id: `construct.${id}`, artifacts: [artifact], program: { id: `program.${id}`, files: [artifact], nodes: [], edges: [], language: 'javascript', packageManager: 'node', entrypoint: artifact.path, build: { command: options.tools.node.path, args: ['--check', artifact.path], cwd: '.' }, test: { command: options.tools.node.path, args: [artifact.path], cwd: '.' } } } }] };
    const contract = baseContract('tool_use', { ...options, attempts: 1 }, { executiveGoal: goal, approvals: ['process.build_test'] });
    return { public: { outputContract: canonical(contract), steps: [{ prompt: locale.given, sources: [], files: {} }] }, private: { kind: 'semantic', expected: [{ disposition: 'succeeded' }], family: 'supplied_goal_execution_not_autonomous_planning' } };
  }
  if (cell.category === 'agentic_autonomous') {
    const rows = Array.from({ length: 12 }, () => ({ group: identifier(rng, 'group').slice(0, 10), value: rng.integer(10000) }));
    for (let n = 1; n < rows.length; n += 3) rows[n].group = rows[0].group;
    const expected = Object.entries(rows.reduce((out, row) => { out[row.group] = (out[row.group] ?? 0) + row.value; return out; }, Object.create(null))).sort(([a], [b]) => a.localeCompare(b)).map(([group, total]) => ({ group, total }));
    const checker = "import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';const rows=JSON.parse(await readFile('input.json','utf8'));const sums=new Map();for(const row of rows)sums.set(row.group,(sums.get(row.group)??0)+row.value);const expected=[...sums].sort(([a],[b])=>a.localeCompare(b)).map(([group,total])=>({group,total}));assert.deepEqual(JSON.parse(await readFile('report.json','utf8')),expected);console.log('public report check passed');\n";
    const publicFiles = { 'input.json': canonical(rows), 'public-check.mjs': checker, 'instructions.txt': 'Write report.json as a JSON array of {group,total}, summing all input values per group, sorted by group using localeCompare. Preserve input/check bytes. Use workspace.read/write/public.check under the public call budget; no plan is supplied.' };
    const contract = baseContract('tool_use', options, { writablePaths: ['report.json'], publicChecks: [{ argv: ['{node}', 'public-check.mjs'] }], toolPolicy: { tools: ['workspace.read', 'workspace.write', 'public.check'], maxCalls: options.toolCalls }, prepareWorkspace: true });
    const dir = path.join(options.privateRoot, 'validators', id); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'check.mjs'), `import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';assert.deepEqual(JSON.parse(await readFile('report.json','utf8')),${canonical(expected)});\n`, { flag: 'wx' });
    return { public: { outputContract: canonical(contract), steps: [{ prompt: `${locale.action}\n${publicFiles['instructions.txt']}`, sources: [], files: publicFiles }] }, private: { kind: 'native', argv: ['{node}', '.sealed-check.mjs'], files: [{ path: `validators/${id}/check.mjs`, target: '.sealed-check.mjs' }], family: 'autonomous_inspect_aggregate_write_verify' } };
  }
  throw new Error(`Missing category provider: ${cell.category}`);
}
export async function createDefaultPool(options) {
  const gaps = coverageGaps(options.inventory, options.tools);
  if (gaps.length && !options.allowMissingCoverage) throw new Error(`Campaign blocked by missing coverage: ${canonical(gaps)}`);
  if (options.count < 2 || options.count % 2) throw new Error('Default balanced provider requires an even count >=2 per cell');
  const rows = [];
  for (const cell of options.inventory.cells) for (let index = 0; index < options.count; index++) {
    const rng = randomStream(options.seed, canonical([cell, index]));
    const id = rng.hex();
    const gap = gaps.find(g => g.language === cell.language);
    const generated = gap ? { public: { outputContract: canonical(baseContract('turn', options, { coverageBlocker: gap })), steps: [{ prompt: 'Coverage remains untested: the preregistered provider or native toolchain is unavailable. This placeholder is a blocking coverage error, not an evaluated product task.', sources: [], files: {} }] }, private: { kind: cell.grading, ...(cell.grading === 'semantic' ? { expected: [{ coverage: 'unavailable' }] } : cell.grading === 'human' ? { dimensions: ['coverage'], rubric: 'Untested coverage placeholder. Do not fabricate a rating.' } : { argv: ['{node}', '-e', 'process.exit(1)'], files: [{ path: 'coverage-unavailable.txt', target: '.coverage-unavailable.txt' }] }), family: gap.kind, coverageGap: gap } } : cell.category.startsWith('code_') ? await codeCase(cell, index, rng, options, id) : await naturalCase(cell, index, rng, options, id);
    rows.push({ id, ...cell, ...generated });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  await mkdir(options.privateRoot, { recursive: true });
  const poolFile = path.join(options.privateRoot, 'pool.jsonl');
  if (gaps.length) await writeFile(path.join(options.privateRoot, 'coverage-unavailable.txt'), 'Explicit blocking coverage placeholder; no product task was executed.\n', { flag: 'wx' });
  await writeFile(poolFile, rows.map(canonical).join('\n') + '\n', { flag: 'wx' });
  return { poolFile, cases: rows.length, familyCounts: rows.reduce((out, row) => { out[row.private.family] = (out[row.private.family] ?? 0) + 1; return out; }, {}) };
}
