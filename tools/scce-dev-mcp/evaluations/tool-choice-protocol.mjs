// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

export function buildToolChoiceSchema(advertisedTools) {
  if (!Array.isArray(advertisedTools) || advertisedTools.length === 0) throw new TypeError('MCP advertised no tools');
  const seen = new Set();
  const branches = advertisedTools.map((tool) => {
    if (!tool || typeof tool.name !== 'string' || !tool.name || !tool.inputSchema || typeof tool.inputSchema !== 'object') {
      throw new TypeError('MCP advertised a tool without a name and inputSchema');
    }
    if (seen.has(tool.name)) throw new TypeError(`MCP advertised duplicate tool: ${tool.name}`);
    seen.add(tool.name);
    return {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: [tool.name] },
        arguments: tool.inputSchema
      },
      required: ['tool', 'arguments'],
      additionalProperties: false
    };
  });
  return { type: 'object', oneOf: branches };
}

export function validateToolChoiceEnvelope(value, advertisedTools) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('model response must be a JSON object');
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'arguments' || keys[1] !== 'tool') throw new TypeError('model response must contain exactly tool and arguments');
  if (!advertisedTools.some((tool) => tool.name === value.tool)) throw new TypeError('model selected a tool that MCP did not advertise');
  if (!value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) throw new TypeError('tool arguments must be a JSON object');
  return { tool: value.tool, arguments: value.arguments };
}

export function parseToolChoice(content, advertisedTools) {
  if (typeof content !== 'string' || content.length === 0) throw new TypeError('model returned no constrained JSON tool choice');
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new TypeError('model response was not valid JSON'); }
  return validateToolChoiceEnvelope(parsed, advertisedTools);
}
