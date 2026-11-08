function object(properties, required = Object.keys(properties)) {
  return { type: 'object', properties, required, additionalProperties: false };
}
function artifacts(contract) {
  const schema = object(Object.fromEntries(contract.writablePaths.map(path => [path, { type: 'string' }])), []);
  if (contract.allowNewFiles === true) schema.additionalProperties = { type: 'string' };
  return schema;
}
export function nativeResponseSchema(input, contract, remainingToolCalls) {
  if (contract.answerMode === 'answer_or_abstain') return { oneOf: [object({ status: { const: 'answered' }, answer: { type: 'string' } }), object({ status: { const: 'abstained' }, answer: { type: 'null' } })] };
  if (contract.operation === 'tool_use' && !contract.executiveGoal && contract.toolPolicy) {
    const readable = [...new Set([...input.steps.flatMap(step => Object.keys(step.files)), ...contract.writablePaths])];
    const choices = [];
    if (contract.toolPolicy.tools.includes('workspace.read') && readable.length) choices.push(object({ tool: { const: 'workspace.read' }, path: { type: 'string', enum: readable } }));
    if (contract.toolPolicy.tools.includes('workspace.write') && contract.writablePaths.length) choices.push(object({ tool: { const: 'workspace.write' }, path: { type: 'string', enum: contract.writablePaths }, content: { type: 'string' } }));
    if (contract.toolPolicy.tools.includes('public.check') && contract.publicChecks.length) choices.push(object({ tool: { const: 'public.check' }, index: { type: 'integer', enum: contract.publicChecks.map((_, i) => i) } }));
    return object({ answer: { type: 'string' }, artifacts: object({}), complete: { type: 'boolean' }, toolCalls: { type: 'array', minItems: 1, maxItems: remainingToolCalls ?? contract.toolPolicy.maxCalls, items: { oneOf: choices } } });
  }
  if (['code_repair', 'code_generation'].includes(contract.operation)) return object({ answer: { type: 'string' }, artifacts: artifacts(contract) });
  if (contract.operation === 'tool_use' && contract.executiveGoal) return object({ answer: { type: 'string' }, artifacts: artifacts(contract), executiveGoal: { const: contract.executiveGoal } });
  return undefined;
}
