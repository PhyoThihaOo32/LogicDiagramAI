const RESERVED = new Set(["XOR", "AND", "OR", "NOT"]);

function normalizeQuotes(text) {
  return String(text || "")
    .replace(/[’‘`]/g, "'")
    .replace(/[·∙]/g, "*")
    .replace(/\r\n/g, "\n");
}

function normalizeExpression(expression) {
  return normalizeQuotes(expression)
    // Expand NAND / NOR / XNOR used as binary infix operators BEFORE stripping AND/OR/XOR.
    // Handles simple cases: A XNOR B, (expr) NAND (expr), etc.
    // Applied repeatedly so chains like A NAND B NAND C reduce correctly left-to-right.
    .replace(/\(\s*([^()]+?)\s*\)\s+XNOR\s+\(\s*([^()]+?)\s*\)/gi, "!(($1) ^ ($2))")
    .replace(/\(\s*([^()]+?)\s*\)\s+NAND\s+\(\s*([^()]+?)\s*\)/gi, "!(($1) * ($2))")
    .replace(/\(\s*([^()]+?)\s*\)\s+NOR\s+\(\s*([^()]+?)\s*\)/gi, "!(($1) + ($2))")
    .replace(/([A-Za-z][A-Za-z0-9_]*)\s+XNOR\s+([A-Za-z][A-Za-z0-9_]*)/gi, "!($1 ^ $2)")
    .replace(/([A-Za-z][A-Za-z0-9_]*)\s+NAND\s+([A-Za-z][A-Za-z0-9_]*)/gi, "!($1 * $2)")
    .replace(/([A-Za-z][A-Za-z0-9_]*)\s+NOR\s+([A-Za-z][A-Za-z0-9_]*)/gi, "!($1 + $2)")
    .replace(/\bAND\b/gi, "*")
    .replace(/\bOR\b/gi, "+")
    .replace(/\bNOT\b/gi, "!")
    .replace(/\bXOR\b/gi, "^")
    .replace(/\s+/g, " ")
    .trim();
}

function extractIdentifiers(text) {
  const normalized = normalizeQuotes(text);
  const matches = normalized.match(/[A-Za-z][A-Za-z0-9_]*/g) || [];
  return [
    ...new Set(
      matches
        .flatMap(splitCompoundIdentifier)
        .filter((name) => !RESERVED.has(name.toUpperCase()))
    )
  ];
}

function splitCompoundIdentifier(identifier) {
  if (!identifier || RESERVED.has(identifier.toUpperCase())) return [identifier];
  if (/^[a-z]/.test(identifier) || identifier.includes("_")) return [identifier];

  const parts = [];
  let i = 0;
  while (i < identifier.length) {
    let part = identifier[i];
    i += 1;

    if (i < identifier.length && /[a-z]/.test(identifier[i])) {
      while (i < identifier.length && /[a-z]/.test(identifier[i])) {
        part += identifier[i];
        i += 1;
      }
      while (i < identifier.length && /\d/.test(identifier[i])) {
        part += identifier[i];
        i += 1;
      }
      parts.push(part);
      continue;
    }

    while (i < identifier.length && /\d/.test(identifier[i])) {
      part += identifier[i];
      i += 1;
    }
    parts.push(part);
  }

  return parts;
}

module.exports = {
  normalizeQuotes,
  normalizeExpression,
  extractIdentifiers,
  splitCompoundIdentifier
};
