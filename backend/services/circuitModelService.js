const { parseExpression, astToText } = require("../utils/booleanEvaluator");

function buildCircuitModel(parsed) {
  const hasFlipFlops = Boolean(parsed.flipFlops && parsed.flipFlops.length);
  const stateVariables = parsed.stateVariables || [];
  const externalInputs = hasFlipFlops
    ? (parsed.inputs || []).filter((input) => !stateVariables.includes(input))
    : [...(parsed.inputs || [])];
  const layoutSignals = [...externalInputs, ...stateVariables];
  const model = {
    projectName: "AI Generated Circuit",
    type: parsed.type,
    subtype: parsed.subtype || "general",
    inputs: externalInputs,
    outputs: [...(parsed.outputs || [])],
    expressions: { ...(parsed.expressions || {}) },
    gates: [],
    wires: [],
    metadata: {
      explanation: parsed.explanation || "",
      stateDiagram: parsed.stateDiagram || null,
      notes: parsed.notes || ""
    }
  };

  const counters = { NOT: 0, AND: 0, OR: 0, XOR: 0, NAND: 0, NOR: 0, XNOR: 0, CONST: 0 };
  // Shared gate cache keyed by canonical AST text; avoids duplicate gates for
  // repeated subexpressions (e.g. A'B' appearing in multiple minterms).
  const gateCache = new Map();
  const inputY = new Map(layoutSignals.map((input, index) => [input, 95 + index * 72]));
  const outputLayouts = [];
  // Maps each output name to { signal, sourceId } so flip-flops can reference the
  // correct logic signal instead of the (non-existent) output name string.
  const outputSignals = new Map();

  parsed.outputs.forEach((output, outputIndex) => {
    const ast = parseExpression(parsed.expressions[output]);
    const layout = layoutAst(ast, outputIndex, inputY, parsed.outputs.length);
    outputLayouts.push(layout);
    const built = buildAstGates(ast, model, { counters, gateCache, inputY }, layout);
    outputSignals.set(output, built);
    // In sequential circuits, D outputs are next-state inputs to flip-flops.
    // They should feed the DFF blocks directly instead of appearing as external
    // output pins, while non-state outputs such as Z/Green/Red remain visible.
    if (!isFlipFlopInputOutput(parsed, output)) {
      const outputGate = {
        id: `output_${output}`,
        type: "OUTPUT",
        label: output,
        x: 210 + (layout.maxDepth + 1) * 118,
        y: layout.rootY - 15,
        inputs: [built.signal],
        output
      };
      model.gates.push(outputGate);
      model.wires.push({ from: built.sourceId, to: outputGate.id, signal: built.signal });
    }
  });

  if (hasFlipFlops) {
    // Compute the right edge of the circuit so flip-flops are placed after it.
    const maxOutputX = Math.max(
      0,
      ...model.gates.filter((g) => g.type === "OUTPUT").map((g) => g.x)
    );
    const dffX = maxOutputX + 100;

    // For sequential circuits add a CLK input if not already present in the model.
    if (!model.inputs.includes("CLK")) {
      const clkY = 95 + model.inputs.length * 72;
      model.inputs.push("CLK");
      inputY.set("CLK", clkY);
    }

    parsed.flipFlops.forEach((name, index) => {
      // Wire D input to the actual logic output signal that computes this flip-flop's
      // next-state value, not to the literal string "name" which has no wire.
      const logic = outputSignals.get(name);
      const dInputSignal = logic ? logic.signal : name;
      const dInputSourceId = logic ? logic.sourceId : name;

      const sourceGate = dInputSourceId ? model.gates.find((gate) => gate.id === dInputSourceId) : null;
      const sourceHeight = sourceGate ? (getGateHeight(sourceGate)) : 50;
      const dffY = sourceGate
        ? sourceGate.y + sourceHeight / 2
        : 95 + (parsed.inputs.length + index) * 72;
      const qOutput = `Q${name.replace(/^D/i, "")}`;
      model.gates.push({
        id: `dff_${name}`,
        type: "D_FLIP_FLOP",
        label: `${name} -> ${qOutput}`,
        x: dffX,
        y: dffY - (GATE_BASE_HEIGHTS.D_FLIP_FLOP / 2),
        inputs: [dInputSignal, "CLK"],
        output: qOutput
      });
      // Wire from logic output to DFF D input
      model.wires.push({ from: dInputSourceId, to: `dff_${name}`, signal: dInputSignal });
      // Wire CLK input to DFF
      model.wires.push({ from: "CLK", to: `dff_${name}`, signal: "CLK" });
    });

    rerouteStateVariableWiresToFlipFlops(model, stateVariables, parsed.flipFlops);
  }

  // Global deconfliction: gates from different output expressions can land at the
  // same (x, y) column. Push overlapping gates apart so the diagram is readable.
  deconflictGlobalPositions(model.gates);
  alignOutputPinsToFinalSources(model);
  alignFlipFlopsToFinalSources(model);

  model.layout = {
    inputs: Object.fromEntries(inputY),
    outputs: Object.fromEntries(parsed.outputs.map((output, index) => [output, outputLayouts[index].rootY])),
    maxDepth: Math.max(1, ...outputLayouts.map((layout) => layout.maxDepth))
  };

  return model;
}

function rerouteStateVariableWiresToFlipFlops(model, stateVariables, flipFlops) {
  const stateSourceByName = new Map();
  flipFlops.forEach((dName) => {
    const qName = `Q${String(dName).replace(/^D/i, "")}`;
    stateSourceByName.set(qName, `dff_${dName}`);
  });

  const stateSet = new Set(stateVariables);
  model.wires.forEach((wire) => {
    if (!stateSet.has(wire.from)) return;
    const sourceId = stateSourceByName.get(wire.from);
    if (sourceId) wire.from = sourceId;
  });
}

function isFlipFlopInputOutput(parsed, output) {
  return Boolean(
    parsed.flipFlops &&
      parsed.flipFlops.some((name) => String(name).toUpperCase() === String(output).toUpperCase())
  );
}

// Base gate heights — multi-input gates (AND/OR/XOR/NAND/NOR/XNOR) scale by 16px per input > 2.
const GATE_BASE_HEIGHTS = { NOT: 42, AND: 50, OR: 52, XOR: 52, NAND: 50, NOR: 52, XNOR: 52, OUTPUT: 32, D_FLIP_FLOP: 62 };
const GATE_WIDTHS      = { NOT: 58, AND: 76, OR: 82, XOR: 88, NAND: 86, NOR: 92, XNOR: 98, OUTPUT: 76, D_FLIP_FLOP: 104 };
const SCALABLE_TYPES   = new Set(["AND", "OR", "XOR", "NAND", "NOR", "XNOR"]);

function getGateHeight(gate) {
  const base = GATE_BASE_HEIGHTS[gate.type] || 50;
  const n = (gate.inputs || []).length;
  return (SCALABLE_TYPES.has(gate.type) && n > 2) ? base + (n - 2) * 16 : base;
}

// Recursively collect all leaves of a left/right-associative chain of the same type.
// e.g. flattenBinaryChain(OR(OR(a,b),c), "OR") → [a, b, c]
function flattenBinaryChain(ast, type) {
  if (ast.type !== type) return [ast];
  return [...flattenBinaryChain(ast.left, type), ...flattenBinaryChain(ast.right, type)];
}

// Re-compute layout depth and centre-Y for a leaf AST node, independent of the
// layout positions map (which only tracks non-VAR nodes).
function getAstMeasure(ast, inputY) {
  if (ast.type === "VAR")   return { depth: 0, y: inputY.get(ast.name) || 120 };
  if (ast.type === "CONST") return { depth: 0, y: 95 };
  if (ast.type === "NOT") {
    const child = getAstMeasure(ast.value, inputY);
    return { depth: child.depth + 1, y: child.y };
  }
  const left  = getAstMeasure(ast.left,  inputY);
  const right = getAstMeasure(ast.right, inputY);
  return { depth: Math.max(left.depth, right.depth) + 1, y: (left.y + right.y) / 2 };
}

function deconflictGlobalPositions(gates) {
  const GAP = 14; // minimum vertical gap between adjacent gates in same column
  // Group gates by their x position (exact match, since x values are multiples of 118).
  const columns = new Map();
  gates.forEach((gate) => {
    if (!columns.has(gate.x)) columns.set(gate.x, []);
    columns.get(gate.x).push(gate);
  });

  columns.forEach((colGates) => {
    if (colGates.length < 2) return;
    colGates.sort((a, b) => a.y - b.y);
    for (let i = 1; i < colGates.length; i++) {
      const prev = colGates[i - 1];
      const prevBottom = prev.y + (getGateHeight(prev));
      const needed = prevBottom + GAP;
      if (colGates[i].y < needed) {
        colGates[i].y = needed;
      }
    }
  });
}

function alignOutputPinsToFinalSources(model) {
  const gatesById = new Map(model.gates.map((gate) => [gate.id, gate]));
  const outputEntries = model.gates
    .filter((gate) => gate.type === "OUTPUT")
    .map((outputGate) => ({
      outputGate,
      wire: model.wires.find((candidate) => candidate.to === outputGate.id)
    }))
    .filter((entry) => entry.wire && gatesById.has(entry.wire.from));

  const entriesBySource = new Map();
  outputEntries.forEach((entry) => {
    if (!entriesBySource.has(entry.wire.from)) entriesBySource.set(entry.wire.from, []);
    entriesBySource.get(entry.wire.from).push(entry);
  });

  entriesBySource.forEach((entries, sourceId) => {
    const sourceGate = gatesById.get(sourceId);
    const sourceHeight = getGateHeight(sourceGate);
    const sourceWidth = GATE_WIDTHS[sourceGate.type] || 104;
    const outputHeight = GATE_BASE_HEIGHTS.OUTPUT;
    const sourceCenterY = sourceGate.y + sourceHeight / 2;
    const gap = 44;
    const hasStateOutputs = entries.some((entry) => /^D\d+$/i.test(entry.outputGate.label || ""));

    entries
      .sort((a, b) => outputPriority(a.outputGate) - outputPriority(b.outputGate))
      .forEach((entry, index) => {
        const { outputGate } = entry;
        const offset = (index - (entries.length - 1) / 2) * gap;
        const y = entries.length === 1 ? sourceCenterY : sourceCenterY + offset;
        const extraX = hasStateOutputs && /^D\d+$/i.test(outputGate.label || "") ? 150 : 64;
        outputGate.y = y - outputHeight / 2;
        outputGate.x = Math.max(outputGate.x, sourceGate.x + sourceWidth + extraX);
      });
  });

  model.gates
    .filter((gate) => gate.type === "OUTPUT")
    .forEach((outputGate) => {
      const wire = model.wires.find((candidate) => candidate.to === outputGate.id);
      const sourceGate = wire ? gatesById.get(wire.from) : null;
      if (!sourceGate) return;

      const sourceWidth = GATE_WIDTHS[sourceGate.type] || 104;
      outputGate.x = Math.max(outputGate.x, sourceGate.x + sourceWidth + 64);
    });
}

function outputPriority(gate) {
  const label = String(gate.label || "");
  if (/^D\d+$/i.test(label)) return 2;
  return 1;
}

function alignFlipFlopsToFinalSources(model) {
  const gatesById = new Map(model.gates.map((gate) => [gate.id, gate]));
  const maxOutputRight = Math.max(
    0,
    ...model.gates
      .filter((gate) => gate.type === "OUTPUT")
      .map((gate) => gate.x + (GATE_WIDTHS.OUTPUT || 76))
  );
  const maxLogicRight = Math.max(
    0,
    ...model.gates
      .filter((gate) => gate.type !== "OUTPUT" && gate.type !== "D_FLIP_FLOP")
      .map((gate) => gate.x + (GATE_WIDTHS[gate.type] || 104))
  );
  const flipFlopX = Math.max(maxOutputRight, maxLogicRight) + 40;

  model.gates
    .filter((gate) => gate.type === "D_FLIP_FLOP")
    .forEach((flipFlop) => {
      const dSignal = flipFlop.inputs && flipFlop.inputs[0];
      const dWire = model.wires.find((wire) => wire.to === flipFlop.id && wire.signal === dSignal);
      const sourceGate = dWire ? gatesById.get(dWire.from) : null;
      if (sourceGate) {
        const sourceHeight = getGateHeight(sourceGate);
        flipFlop.y = sourceGate.y + sourceHeight / 2 - GATE_BASE_HEIGHTS.D_FLIP_FLOP / 2;
      }
      flipFlop.x = Math.max(flipFlop.x, flipFlopX);
    });
}

function buildAstGates(ast, model, context, layout) {
  const { counters, gateCache, inputY } = context;

  if (ast.type === "VAR") {
    return { signal: ast.name, sourceId: ast.name };
  }
  if (ast.type === "CONST") {
    // Synthesise a CONST gate so the wire has a valid sourceId in the model.
    // Use the gateCache so repeated constants share one gate node.
    const cacheKey = `__CONST_${ast.value}`;
    if (gateCache.has(cacheKey)) return gateCache.get(cacheKey);
    const signal = String(ast.value);
    const constId = `const_${ast.value}_${++counters.CONST}`;
    model.gates.push({
      id: constId,
      type: "CONST",
      label: signal,
      x: 34,
      y: 95,
      inputs: [],
      output: signal
    });
    const result = { signal, sourceId: constId };
    gateCache.set(cacheKey, result);
    return result;
  }

  // Check shared gate cache before building a new gate.
  const cacheKey = astToText(ast);
  if (gateCache.has(cacheKey)) {
    return gateCache.get(cacheKey);
  }

  if (ast.type === "NOT") {
    // Collapse NOT(AND) → NAND, NOT(OR) → NOR, NOT(XOR) → XNOR.
    // Also flatten inner chains: NOT(AND(AND(a,b),c)) → 3-input NAND.
    const inner = ast.value;
    if (inner.type === "AND" || inner.type === "OR" || inner.type === "XOR") {
      const compoundType = inner.type === "AND" ? "NAND" : inner.type === "OR" ? "NOR" : "XNOR";
      const leaves = flattenBinaryChain(inner, inner.type);
      const allInputs = leaves.map((leaf) => buildAstGates(leaf, model, context, layout));
      const id = `${compoundType.toLowerCase()}_${++counters[compoundType]}`;
      const signal = `${compoundType.toLowerCase()}_${counters[compoundType]}_out`;
      const { x, y } = gatePosition(leaves, compoundType, layout, inputY);
      model.gates.push({
        id, type: compoundType, label: astToText(ast),
        x, y, inputs: allInputs.map((i) => i.signal), output: signal
      });
      allInputs.forEach((inp) => model.wires.push({ from: inp.sourceId, to: id, signal: inp.signal }));
      const result = { signal, sourceId: id };
      gateCache.set(cacheKey, result);
      return result;
    }

    const input = buildAstGates(ast.value, model, context, layout);
    const id = `not_${++counters.NOT}`;
    const signal = `${input.signal}_not_${counters.NOT}`;
    const point = layout.positions.get(ast);
    const alignedY =
      ast.value.type === "VAR" && inputY.has(ast.value.name)
        ? inputY.get(ast.value.name)
        : (point ? point.y : 95);
    model.gates.push({
      id, type: "NOT", label: astToText(ast),
      x: point ? point.x : 150, y: alignedY - 21,
      inputs: [input.signal], output: signal
    });
    model.wires.push({ from: input.sourceId, to: id, signal: input.signal });
    const result = { signal, sourceId: id };
    gateCache.set(cacheKey, result);
    return result;
  }

  // Flatten associative chains: OR(OR(a,b),c) → single 3-input OR gate, etc.
  const leaves = flattenBinaryChain(ast, ast.type);
  const allInputs = leaves.map((leaf) => buildAstGates(leaf, model, context, layout));
  const id = `${ast.type.toLowerCase()}_${++counters[ast.type]}`;
  const signal = `${ast.type.toLowerCase()}_${counters[ast.type]}_out`;
  const { x, y } = gatePosition(leaves, ast.type, layout, inputY);
  model.gates.push({
    id, type: ast.type, label: astToText(ast),
    x, y, inputs: allInputs.map((i) => i.signal), output: signal
  });
  allInputs.forEach((inp) => model.wires.push({ from: inp.sourceId, to: id, signal: inp.signal }));
  const result = { signal, sourceId: id };
  gateCache.set(cacheKey, result);
  return result;
}

// Compute x/y position for a gate given its flattened leaf nodes.
// Uses the max-depth of any leaf + 1 column, centred on the average leaf Y.
function gatePosition(leaves, type, layout, inputY) {
  if (leaves.length === 2) {
    // For binary gates keep using the pre-computed layout position when available.
    const pos = layout.positions.get(leaves[0]) || layout.positions.get(leaves[1]);
    // Prefer the outer gate's position if the leaves are themselves AST nodes:
    // fall through to depth-based calculation if leaves are VARs (no position entry).
    if (pos) {
      const baseH = GATE_BASE_HEIGHTS[type] || 50;
      return { x: pos.x + 118, y: pos.y - baseH / 2 };
    }
  }
  const measures = leaves.map((leaf) => getAstMeasure(leaf, inputY));
  const maxDepth = Math.max(0, ...measures.map((m) => m.depth));
  const avgY = measures.reduce((s, m) => s + m.y, 0) / measures.length;
  const n = leaves.length;
  const baseH = GATE_BASE_HEIGHTS[type] || 50;
  const h = (SCALABLE_TYPES.has(type) && n > 2) ? baseH + (n - 2) * 16 : baseH;
  return { x: 150 + (maxDepth + 1) * 118, y: avgY - h / 2 };
}

function layoutAst(ast, outputIndex, inputY, outputCount) {
  const positions = new Map();
  const depthByNode = new Map();
  const laneSpacing = 64;
  // Multiple-output circuits such as decoders need one compact lane per output.
  // A full input-height band per output makes simple decoders far too tall.
  const outputBand =
    outputCount > 1
      ? Math.max(84, Math.min(126, inputY.size * 36 + 16))
      : Math.max(210, inputY.size * 72 + 64);
  const bandStart = 82 + outputIndex * outputBand;
  let syntheticLeafLane = 0;

  function measure(node) {
    if (node.type === "VAR") return { depth: 0, y: inputY.get(node.name) || 120 };
    if (node.type === "CONST") {
      syntheticLeafLane += 1;
      return { depth: 0, y: bandStart + syntheticLeafLane * laneSpacing };
    }
    if (node.type === "NOT") {
      const child = measure(node.value);
      const depth = child.depth + 1;
      depthByNode.set(node, depth);
      positions.set(node, { x: 150 + depth * 118, y: child.y });
      return { depth, y: child.y };
    }
    const left = measure(node.left);
    const right = measure(node.right);
    const depth = Math.max(left.depth, right.depth) + 1;
    const y = (left.y + right.y) / 2;
    depthByNode.set(node, depth);
    positions.set(node, { x: 150 + depth * 118, y });
    return { depth, y };
  }

  const root = measure(ast);
  const minY = Math.min(...[...positions.values()].map((point) => point.y), root.y);
  const shift = Math.max(0, bandStart - minY);
  if (outputCount > 1 && shift) {
    positions.forEach((point) => {
      point.y += shift;
    });
    root.y += shift;
  }

  resolveColumnCollisions(positions);

  return {
    positions,
    rootY: root.y,
    maxDepth: root.depth
  };
}

function resolveColumnCollisions(positions) {
  const minGap = 72;
  const columns = new Map();
  positions.forEach((point) => {
    if (!columns.has(point.x)) columns.set(point.x, []);
    columns.get(point.x).push(point);
  });

  columns.forEach((points) => {
    points.sort((a, b) => a.y - b.y);
    const groups = [];
    points.forEach((point) => {
      const group = groups[groups.length - 1];
      if (!group || point.y - group[group.length - 1].y >= minGap) {
        groups.push([point]);
      } else {
        group.push(point);
      }
    });

    groups.forEach((group) => {
      if (group.length < 2) return;
      const center = group.reduce((sum, point) => sum + point.y, 0) / group.length;
      group.forEach((point, index) => {
        point.y = center + (index - (group.length - 1) / 2) * minGap;
      });
      const minY = Math.min(...group.map((point) => point.y));
      if (minY < 92) {
        const shift = 92 - minY;
        group.forEach((point) => {
          point.y += shift;
        });
      }
    });
  });
}

module.exports = { buildCircuitModel };
