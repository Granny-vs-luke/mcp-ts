const CALIBRATION_DIVISOR = 3.6;

function classifyChar(ch) {
  const code = ch.charCodeAt(0);
  if (code <= 0x20 || ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ':' || ch === ',') return 1.0;
  if (code >= 0x21 && code <= 0x2f) return 1.5;
  if (code >= 0x30 && code <= 0x39) return 2.0;
  if (code >= 0x41 && code <= 0x5a) return 3.5;
  if (code >= 0x61 && code <= 0x7a) return 4.0;
  return 2.5;
}

function stringifyJson(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, nestedValue) => {
    if (!nestedValue || typeof nestedValue !== 'object') {
      return nestedValue;
    }

    if (seen.has(nestedValue)) {
      return '[Circular]';
    }

    seen.add(nestedValue);
    return nestedValue;
  });
}

export function estimateTextTokens(text) {
  let weightedLen = 0;
  const source = String(text);

  for (let i = 0; i < source.length; i++) {
    weightedLen += 1 / classifyChar(source[i]);
  }

  return Math.ceil(weightedLen / (1 / CALIBRATION_DIVISOR));
}

export function estimateToolTokens(tool) {
  const parts = [tool.name];
  if (tool.description) parts.push(tool.description);
  if (tool.inputSchema) parts.push(stringifyJson(tool.inputSchema));

  return estimateTextTokens(parts.join(' '));
}

export function estimateToolsTokens(tools) {
  return tools.reduce((sum, tool) => sum + estimateToolTokens(tool), 0);
}
