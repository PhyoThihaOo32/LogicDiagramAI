/**
 * vhdlParser.js
 *
 * Parses a subset of VHDL entity/architecture source into the same circuit
 * object format that the rest of the backend pipeline expects.
 *
 * Supported:
 *   - std_logic / std_ulogic port declarations (in / out)
 *   - Concurrent signal assignments: output <= expression;
 *   - Operators: and, or, not, xor (case-insensitive VHDL keywords)
 *   - Parentheses for grouping
 *
 * Unsupported (falls through to AI): nand, nor, xnor, std_logic_vector,
 *   process blocks, if/case statements, generics, sequential logic.
 */

// Reserved VHDL operator keywords — never treated as signal names.
const VHDL_OPERATORS = new Set(["and", "or", "not", "xor", "nand", "nor", "xnor"]);

/**
 * Normalize a VHDL signal name so it doesn't get incorrectly split by the
 * Boolean evaluator's splitCompoundIdentifier (which splits all-uppercase
 * identifiers like SUM → S·U·M).
 *
 * Rules:
 *  - Single characters stay unchanged (A, B are fine).
 *  - Names that already contain a lowercase letter are fine.
 *  - All-uppercase multi-char names get first letter uppercase, rest lowercase:
 *    SUM → Sum, CIN → Cin, COUT → Cout.
 */
function normalizeSignalName(name) {
  if (!name || name.length <= 1) return name;
  if (/[a-z]/.test(name)) return name; // already has lowercase → safe
  // All-uppercase: convert to title-case
  return name[0].toUpperCase() + name.slice(1).toLowerCase();
}

/**
 * Convert a VHDL expression string to a Boolean algebra string understood by
 * normalizeExpression / parseExpression.
 *
 * signalMap: Map<lowercase_name, canonical_name>
 */
function vhdlExprToBool(expr, signalMap) {
  // Check for unsupported compound operators
  if (/\b(?:nand|nor|xnor)\b/i.test(expr)) {
    throw new Error(`Unsupported VHDL operator in expression: ${expr}`);
  }

  // Replace every word token — convert operators to uppercase keywords and
  // map signal names to their canonical (normalized) form.
  return expr
    .replace(/\b(\w+)\b/g, (word) => {
      const lower = word.toLowerCase();
      if (VHDL_OPERATORS.has(lower)) return word.toUpperCase();
      if (signalMap.has(lower)) return signalMap.get(lower);
      return word; // unknown identifier — pass through
    })
    .trim();
}

/**
 * Parse a VHDL source string and return a parsed circuit object.
 * Throws on unrecognised/unsupported VHDL.
 */
function parseVhdl(vhdlText) {
  // Strip line comments and normalise line endings.
  const text = vhdlText
    .replace(/--[^\n]*/g, "")
    .replace(/\r\n/g, "\n");

  // ── 1. Port declarations ──────────────────────────────────────────────────
  const portMatch = text.match(/\bport\s*\(\s*([\s\S]*?)\s*\)\s*;/i);
  if (!portMatch) throw new Error("No port declaration found in VHDL input.");

  const rawInputs = [];
  const rawOutputs = [];

  portMatch[1].split(";").forEach((segment) => {
    const seg = segment.trim();
    if (!seg) return;
    // "a, b : in std_logic" or "y1, y2 : out std_logic"
    const m = seg.match(/^([\w\s,]+?)\s*:\s*(in|out)\b/i);
    if (!m) return;
    const names = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (m[2].toLowerCase() === "in") rawInputs.push(...names);
    else rawOutputs.push(...names);
  });

  if (!rawInputs.length || !rawOutputs.length) {
    throw new Error("Could not parse port signals from VHDL input.");
  }

  // Normalize names and build a case-insensitive lookup map.
  const inputs = rawInputs.map(normalizeSignalName);
  const outputs = rawOutputs.map(normalizeSignalName);

  // signalMap: lowercase(raw_name) → canonical normalized name
  const signalMap = new Map();
  rawInputs.forEach((raw, i) => signalMap.set(raw.toLowerCase(), inputs[i]));
  rawOutputs.forEach((raw, i) => signalMap.set(raw.toLowerCase(), outputs[i]));

  // ── 2. Concurrent signal assignments ─────────────────────────────────────
  // Find the architecture body: everything between the first 'begin' and the
  // final 'end <name>;' (or 'end;').
  const bodyMatch = text.match(
    /\bbegin\b([\s\S]*?)(?:\bend\s+\w+\s*;|\bend\s*;)/i
  );
  if (!bodyMatch) throw new Error("No architecture body found in VHDL input.");

  const body = bodyMatch[1];
  const expressions = {};

  const assignRe = /(\w+)\s*<=([\s\S]*?);/g;
  let match;
  while ((match = assignRe.exec(body)) !== null) {
    const rawSignal = match[1].trim();
    const rawExpr = match[2].trim();
    const lower = rawSignal.toLowerCase();
    if (!signalMap.has(lower)) continue; // not a declared port signal

    // Only outputs get expressions.
    const isOutput = rawOutputs.some((r) => r.toLowerCase() === lower);
    if (!isOutput) continue;

    const canonical = signalMap.get(lower);
    expressions[canonical] = vhdlExprToBool(rawExpr, signalMap);
  }

  const missing = outputs.filter((o) => !expressions[o]);
  if (missing.length) {
    throw new Error(
      `No concurrent assignment found for output(s): ${missing.join(", ")}`
    );
  }

  return {
    type: "combinational",
    subtype: "vhdl",
    inputs,
    outputs,
    expressions,
    flipFlops: [],
    stateVariables: [],
    explanation: "Parsed from VHDL source.",
    notes: ""
  };
}

/**
 * Returns true if the text looks like VHDL source code.
 * Used to decide whether to try the VHDL parser before calling the AI.
 */
function looksLikeVhdl(text) {
  const t = String(text || "").toLowerCase();
  return (
    /\bentity\b/.test(t) &&
    /\barchitecture\b/.test(t) &&
    /\bport\b/.test(t) &&
    /<=/.test(t) &&
    /\bbegin\b/.test(t)
  );
}

module.exports = { parseVhdl, looksLikeVhdl };
