/**
 * vhdlGenerator.js
 *
 * Generates synthesisable VHDL source (entity + architecture) from a parsed
 * circuit object produced by logicParser / aiService.
 *
 * Supports: combinational circuits with AND / OR / NOT / XOR operators.
 * Output is a valid subset of VHDL-93 / VHDL-2008.
 */

/**
 * Convert a Boolean algebra expression (internal format) to VHDL syntax.
 *
 * Internal format uses:
 *   A'   → NOT A
 *   AB   → A AND B  (implicit AND — but we receive fully-expanded text like "A AND B")
 *   +    → OR
 *   XOR  → XOR keyword
 *
 * The expressions stored in parsed.expressions are already processed by
 * normalizeExpression and use explicit operators (AND / OR / NOT / XOR).
 */
function boolToVhdlExpr(expr) {
  if (!expr) return "\'0\'";

  // Replace NOT prefix with VHDL NOT keyword (handles NOT(x) → not x forms).
  let s = String(expr).trim();

  // Implicit AND: sequences like "A' B" or "A'B" — normalizeExpression should
  // have already added AND, but handle the apostrophe-NOT form just in case.
  // We rely on the expression already having explicit operators from the pipeline.

  // Map operator keywords to lowercase VHDL style
  s = s
    .replace(/\bNOT\b/g, "not")
    .replace(/\bAND\b/g, "and")
    .replace(/\bOR\b/g, "or")
    .replace(/\bXOR\b/g, "xor");

  // Handle A' shorthand → (not A)   — any identifier immediately followed by '
  s = s.replace(/([A-Za-z_]\w*)'(?!')/g, "(not $1)");

  return s;
}

/**
 * Sanitise a signal name to a legal VHDL identifier.
 * VHDL identifiers must start with a letter, contain only letters/digits/underscores,
 * and must not end with an underscore or contain consecutive underscores.
 */
function toVhdlId(name) {
  let id = String(name || "sig")
    .replace(/[^A-Za-z0-9_]/g, "_")   // replace illegal chars
    .replace(/^[_\d]+/, (m) => `e${m}`) // cannot start with digit or underscore
    .replace(/__+/g, "_")              // no consecutive underscores
    .replace(/_+$/, "");              // cannot end with underscore

  // VHDL reserved words — prefix with sig_ to avoid collision
  const reserved = new Set([
    "signal","variable","constant","type","subtype","entity","architecture",
    "port","generic","begin","end","process","if","then","else","elsif","case",
    "when","others","and","or","not","xor","nand","nor","xnor","in","out",
    "inout","buffer","linkage","is","of","to","downto","all","use","library",
    "package","component","map","open","null","wait","report","severity",
    "assert","generate","for","loop","while","with","select","return"
  ]);

  if (reserved.has(id.toLowerCase())) id = `sig_${id}`;
  return id || "sig";
}

/**
 * Generate a VHDL source string for the given parsed circuit.
 *
 * @param {object} parsed  – circuit object with inputs[], outputs[], expressions{}
 * @param {string} entityName – optional entity name (defaults to derived from subtype)
 * @returns {string} – complete VHDL source text
 */
function generateVhdl(parsed, entityName) {
  const inputs  = (parsed.inputs  || []).map(toVhdlId);
  const outputs = (parsed.outputs || []).map(toVhdlId);
  const exprs   = parsed.expressions || {};

  // Derive entity name from subtype or outputs
  if (!entityName) {
    if (parsed.subtype && parsed.subtype !== "general" && parsed.subtype !== "ai") {
      entityName = parsed.subtype.replace(/[^A-Za-z0-9]/g, "_").replace(/__+/g, "_");
    } else if (outputs.length === 1) {
      entityName = `circuit_${outputs[0].toLowerCase()}`;
    } else {
      entityName = "ai_generated_circuit";
    }
  }

  const eName = toVhdlId(entityName);

  const lines = [];

  // Library/use clauses
  lines.push("library IEEE;");
  lines.push("use IEEE.std_logic_1164.all;");
  lines.push("");

  // Entity declaration
  lines.push(`entity ${eName} is`);
  lines.push("  port (");

  const portLines = [];
  inputs.forEach((inp) => {
    portLines.push(`    ${inp.padEnd(12)} : in  std_logic`);
  });
  outputs.forEach((out) => {
    portLines.push(`    ${out.padEnd(12)} : out std_logic`);
  });

  // Join with semicolon between ports (last port has no trailing semicolon)
  portLines.forEach((pl, i) => {
    lines.push(pl + (i < portLines.length - 1 ? ";" : ""));
  });

  lines.push("  );");
  lines.push(`end entity ${eName};`);
  lines.push("");

  // Architecture
  lines.push(`architecture rtl of ${eName} is`);
  lines.push("begin");
  lines.push("");

  // Concurrent signal assignments for each output
  const rawOutputs = parsed.outputs || [];
  rawOutputs.forEach((rawOut) => {
    const vhdlOut = toVhdlId(rawOut);
    const expr    = exprs[rawOut] || "";
    const vExpr   = boolToVhdlExpr(expr) || "'0'";
    lines.push(`  ${vhdlOut} <= ${vExpr};`);
  });

  lines.push("");
  lines.push(`end architecture rtl;`);
  lines.push("");

  return lines.join("\n");
}

module.exports = { generateVhdl };
