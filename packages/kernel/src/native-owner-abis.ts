// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { ProgramPlan } from "./program-planner.js";
import { ownedNativeCallableAbi, type ProgramNativeCallableAbi } from "./program-native-abi.js";
import { nativeProgramType, type NativeProgramType } from "./native-program-types.js";

export class NativeProgramEmissionError extends Error {
  constructor(readonly reasonId: string, message: string) { super(message); this.name = "NativeProgramEmissionError"; }
}
export interface NativeOwnerAbi { name: string; abi: ProgramNativeCallableAbi; parameters: NativeProgramType[]; result: NativeProgramType }

/** One public source declaration owns each typed wrapper, including every operation in a stateful trace. */
export function nativeOwnerAbis(plan: ProgramPlan, languageId: "go" | "rust"): NativeOwnerAbi[] {
  const out = new Map<string, NativeOwnerAbi>();
  const add = (name: string, arity: number, value: ProgramNativeCallableAbi | undefined,
    owner: ProgramNativeCallableAbi["owner"] & { callableName: string }) => {
    const abi = value && ownedNativeCallableAbi(value, { ...owner, languageId });
    if (!abi) throw new NativeProgramEmissionError("program.emission.native_abi_missing", `No owned ${languageId} declaration for ${name}`);
    if(name!==abi.callableName) throw new NativeProgramEmissionError("program.emission.native_abi_callable", "Native emission preserves the source-declared callable name");
    if (arity !== abi.parameters.length) throw new NativeProgramEmissionError("program.emission.native_abi_arity", `Declared native arity differs for ${name}`);
    const parameters = abi.parameters.map(parameter => nativeProgramType(languageId, parameter.type.text));
    const result = nativeProgramType(languageId, abi.returnType?.text);
    if (!result || parameters.some(type => !type || type.kind === "unit")) throw new NativeProgramEmissionError("program.emission.native_abi_type_unsupported", `Unsupported declared native type for ${name}`);
    const previous = out.get(name);
    if (previous && previous.abi.id !== abi.id) throw new NativeProgramEmissionError("program.emission.native_abi_ambiguous", `Multiple native declarations own ${name}`);
    out.set(name, { name, abi, parameters: parameters as NativeProgramType[], result });
  };
  for (const requirement of plan.ownerBehaviorRequirements) {
    const source = requirement.sourceContract, abi = source?.nativeAbi;
    if (!source || !abi) throw new NativeProgramEmissionError("program.emission.native_abi_missing", `No native source ABI for ${requirement.callableId}`);
    add(requirement.callableId, requirement.arguments.length, abi, { targetSymbolId: source.targetSymbolId, sourcePath: source.sourcePath,
      sourceHash: source.sourceHash, sourceVersionId: source.sourceVersionId, callableName: abi.callableName });
  }
  for (const requirement of plan.ownerStatefulBehaviorRequirements) for (const [index, invocation] of requirement.invocations.entries()) {
    const source = requirement.sourceContract?.invocations[index];
    if (!source) throw new NativeProgramEmissionError("program.emission.native_abi_missing", `No native source ABI for ${invocation.callableId}`);
    add(invocation.callableId, invocation.arguments.length, source.nativeAbi, { targetSymbolId: source.targetSymbolId, sourcePath: source.sourcePath,
      sourceHash: source.sourceHash, sourceVersionId: source.sourceVersionId, callableName: source.targetName });
  }
  if (!out.size) throw new NativeProgramEmissionError("program.emission.native_owner_behavior_missing", "Native emission needs owned callable behavior");
  return [...out.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
