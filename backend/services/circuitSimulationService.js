// ─────────────────────────────────────────────────────────────────────────────
// Gate-graph simulation & model verification
//
// circuitModelService builds a list of gates+wires from the AI's expressions.
// If that translation is buggy (wire connected to the wrong source, gate type
// wrong, fan-out missed) the diagram and the truth table can disagree — even
// though both came from the same expressions, the truth table is computed
// directly from the AST while the diagram is computed from the graph.
//
// This service catches that class of bug by independently *simulating* the
// gate graph: walking gate-by-gate, propagating signal values, and asserting
// that the OUTPUT-pin gates produce the same truth table that the expressions
// did.  No AI cost — pure local check.
// ─────────────────────────────────────────────────────────────────────────────

const { generateTruthTable } = require("./truthTableService");

/**
 * Simulate the gate graph for a single input vector.
 * Returns a Map of signal-name → 0/1.
 *
 * Gates expose a `.output` signal name (or undefined for OUTPUT pins) and an
 * `.inputs` array of signal names.  We resolve recursively with cycle
 * protection (any cycle defaults to 0 — this is only used for combinational
 * verification; sequential circuits with feedback are skipped earlier).
 */
function simulateModel(model, inputValues) {
  const signals = { ...inputValues };
  // CLK gets a default high value if used but not provided.
  if ((model.inputs || []).includes("CLK") && signals.CLK === undefined) signals.CLK = 1;

  // Build producer index once: signalName → gate that produces it.
  const producers = new Map();
  for (const gate of model.gates || []) {
    if (gate.output) producers.set(gate.output, gate);
  }

  const visiting = new Set();

  function resolve(signal) {
    if (signals[signal] !== undefined) return Number(signals[signal]) || 0;
    const producer = producers.get(signal);
    if (!producer) return 0; // unknown signal → 0 (sane default for unconnected nodes)
    if (visiting.has(producer.id)) return 0; // cycle (shouldn't happen for combinational)
    visiting.add(producer.id);
    const value = evaluateGate(producer);
    visiting.delete(producer.id);
    signals[signal] = value;
    return value;
  }

  function evaluateGate(gate) {
    const inputVals = (gate.inputs || []).map(resolve);
    switch (gate.type) {
      case "AND":  return inputVals.length && inputVals.every((v) => v) ? 1 : 0;
      case "OR":   return inputVals.some((v) => v) ? 1 : 0;
      case "NOT":  return inputVals[0] ? 0 : 1;
      case "XOR":  return inputVals.reduce((a, b) => a ^ b, 0);
      case "NAND": return inputVals.length && inputVals.every((v) => v) ? 0 : 1;
      case "NOR":  return inputVals.some((v) => v) ? 0 : 1;
      case "XNOR": return inputVals.reduce((a, b) => a ^ b, 0) ? 0 : 1;
      case "OUTPUT":
      case "D_FLIP_FLOP": return inputVals[0] || 0; // pass-through for sim purposes
      case "CONST": return Number(gate.label) || 0;
      default: return 0;
    }
  }

  // Force evaluation of every produced signal so the result map is complete.
  for (const gate of model.gates || []) {
    if (gate.output) resolve(gate.output);
  }
  return signals;
}

/**
 * Verify the built circuit model graph computes the same truth table as the
 * Boolean expressions it was built from.  Returns:
 *   { skipped: true, reason }                              — skipped
 *   { skipped: false, verified: true,  rowsTested }        — graph matches
 *   { skipped: false, verified: false, issueCount, issues } — model is buggy
 */
function verifyModelGraph(model, parsed) {
  if (!model || !parsed) return { skipped: true, reason: "Missing model or parsed circuit" };
  if (parsed.type === "sequential") {
    return { skipped: true, reason: "Sequential graph verification needs state simulation (not yet implemented)" };
  }

  const inputs = parsed.inputs || [];
  const outputs = parsed.outputs || [];
  if (inputs.length === 0 || outputs.length === 0) {
    return { skipped: true, reason: "No inputs or outputs to verify" };
  }
  if (inputs.length > 10) {
    return { skipped: true, reason: `Too many inputs (${inputs.length}) for full graph simulation` };
  }

  const expected = generateTruthTable(parsed);
  if (!expected.length) return { skipped: true, reason: "Truth table empty" };

  // Map output name → the OUTPUT gate that drives it, plus the signal that
  // feeds that gate.  We compare the *signal value* the OUTPUT pin receives,
  // since that is what the diagram and downstream tools will display.
  const outputGates = new Map();
  for (const gate of model.gates || []) {
    if (gate.type === "OUTPUT" && gate.label) outputGates.set(gate.label, gate);
  }

  const issues = [];
  for (const row of expected) {
    const inputValues = {};
    for (const inp of inputs) inputValues[inp] = Number(row[inp]) || 0;

    const sim = simulateModel(model, inputValues);

    for (const output of outputs) {
      const outGate = outputGates.get(output);
      if (!outGate) continue;
      const feedSignal = (outGate.inputs || [])[0];
      const simValue = Number(sim[feedSignal] ?? 0);
      const expValue = Number(row[output]);
      if (simValue !== expValue) {
        issues.push({
          inputs: { ...inputValues },
          output,
          expected: expValue,
          simulated: simValue,
          drivenBy: feedSignal
        });
      }
    }
  }

  return {
    skipped: false,
    verified: issues.length === 0,
    rowsTested: expected.length,
    issueCount: issues.length,
    issues: issues.slice(0, 6)
  };
}

module.exports = { simulateModel, verifyModelGraph };
