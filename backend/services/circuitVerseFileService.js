function generateCircuitVerseFile(circuitModel) {
  const cvJson = generateExperimentalCvJson(circuitModel);
  const serialized = JSON.stringify(cvJson);
  validateCvCompatibility(serialized);
  return Buffer.from(serialized, "utf8");
}

function generateExperimentalCvJson(circuitModel) {
  const scopeId = Date.now();
  const scope = buildCircuitVerseScope(circuitModel, scopeId);
  return {
    name: circuitModel.projectName || "AI Generated Circuit",
    timePeriod: 500,
    clockEnabled: true,
    projectId: makeProjectId(),
    focussedCircuit: scopeId,
    orderedTabs: [scopeId],
    scopes: [scope]
  };
}

function buildCircuitVerseScope(circuitModel, scopeId) {
  const scope = {
    layout: { width: 100, height: 60, title_x: 50, title_y: 13, titleEnabled: true },
    verilogMetadata: {
      isVerilogCircuit: false,
      isMainCircuit: false,
      code: "// Write Some Verilog Code Here!",
      subCircuitScopeIds: []
    },
    allNodes: [],
    id: scopeId,
    name: "Main",
    restrictedCircuitElementsUsed: [],
    nodes: []
  };

  const layout = computeCvLayout(circuitModel);
  const registry = new Map();

  const inputElements = (circuitModel.inputs || []).map((input, index) => {
    const y = layout.inputY.get(input) || (120 + index * 80);
    const element = createElementRecord(scope, {
      id: input,
      objectType: "Input",
      label: input,
      x: layout.inputX,
      y,
      direction: "RIGHT",
      labelDirection: "LEFT",
      propagationDelay: 0,
      inputCount: 0,
      outputCount: 1,
      outputNodeOffset: { x: 10, y: 0 },
      constructorParamaters: ["RIGHT", 1, { x: 0, y: (index + 1) * 20, id: randomId() }],
      values: { state: 0 }
    });
    registry.set(input, element);
    return element.saveObject;
  });

  const outputIndex = { value: 0 };
  const gateElements = (circuitModel.gates || []).map((gate) => {
    const objectType = mapGateToCircuitVerseElement(gate).type;
    const isOutput = objectType === "Output";
    const isNot = objectType === "NotGate";
    const numInputs = isOutput ? 1 : (isNot ? 1 : Math.max(2, (gate.inputs || []).length));
    const numOutputs = isOutput ? 0 : 1;

    let constructorParamaters;
    let direction = "RIGHT";
    let labelDirection = "RIGHT";
    let propagationDelay = 100;

    const pos = layout.gatePos.get(gate.id) || { x: 250, y: 150 };
    let x = Math.round(pos.x);
    let y = Math.round(pos.y);

    if (isOutput) {
      const idx = outputIndex.value++;
      direction = "LEFT";
      labelDirection = "RIGHT";
      propagationDelay = 0;
      constructorParamaters = ["LEFT", 1, { x: 100, y: (idx + 1) * 20, id: randomId() }];
    } else if (isNot) {
      constructorParamaters = ["RIGHT", 1];
    } else {
      constructorParamaters = ["RIGHT", numInputs, 1];
    }

    const element = createElementRecord(scope, {
      id: gate.id,
      objectType,
      label: isOutput ? gate.label : "",
      x,
      y,
      direction,
      labelDirection,
      propagationDelay,
      inputCount: numInputs,
      outputCount: numOutputs,
      inputNodeOffset: isOutput ? { x: 10, y: 0 } : null,
      constructorParamaters
    });
    registry.set(gate.id, element);
    return element.saveObject;
  });

  connectCircuitVerseNodes(circuitModel.wires || [], registry, scope.allNodes, scope);

  [...inputElements, ...gateElements].forEach((element) => {
    const key = element.objectType;
    if (!scope[key]) scope[key] = [];
    scope[key].push(element);
  });

  // Add circuit name as Text label
  const circuitName = circuitModel.projectName || "AI Generated Circuit";
  if (!scope.Text) scope.Text = [];
  scope.Text.push({
    x: layout.inputX,
    y: layout.textY,
    objectType: "Text",
    label: circuitName,
    direction: "RIGHT",
    labelDirection: "RIGHT",
    propagationDelay: 10,
    customData: { constructorParamaters: [circuitName, 14] }
  });

  return scope;
}

// Compact layout: places inputs on left, gates in columns spaced 80px apart, outputs on far right.
// Overrides the sprawling positions from circuitModelService.js.
function computeCvLayout(circuitModel) {
  const COL_SPACING = 80;
  const ROW_SPACING = 80;
  const INPUT_X = 150;
  const START_Y = 130;

  const inputs = circuitModel.inputs || [];
  const gates = circuitModel.gates || [];
  const wires = circuitModel.wires || [];

  const gateById = new Map(gates.map((g) => [g.id, g]));

  // Compute gate column depths via wires
  const gateDepth = new Map();
  const visiting = new Set();

  function computeDepth(gateId) {
    if (gateDepth.has(gateId)) return gateDepth.get(gateId);
    if (visiting.has(gateId)) return 1;
    visiting.add(gateId);

    let maxInputDepth = 0;
    wires
      .filter((w) => w.to === gateId)
      .forEach((w) => {
        if (!inputs.includes(w.from) && gateById.has(w.from)) {
          maxInputDepth = Math.max(maxInputDepth, computeDepth(w.from));
        }
      });

    const d = maxInputDepth + 1;
    gateDepth.set(gateId, d);
    visiting.delete(gateId);
    return d;
  }

  gates.forEach((g) => computeDepth(g.id));

  // Group gates by column
  const columns = new Map();
  gates.forEach((g) => {
    const d = gateDepth.get(g.id) || 1;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(g);
  });

  const maxDepth = columns.size > 0 ? Math.max(...columns.keys()) : 1;

  // Input Y positions: evenly spaced
  const inputY = new Map(inputs.map((inp, i) => [inp, START_Y + i * ROW_SPACING]));

  // Gate positions: x = INPUT_X + depth*COL_SPACING, y = avg of input y values
  const gatePos = new Map();

  for (let col = 1; col <= maxDepth; col++) {
    const gatesInCol = (columns.get(col) || []).slice();
    const x = INPUT_X + col * COL_SPACING;

    gatesInCol.forEach((gate) => {
      const srcWires = wires.filter((w) => w.to === gate.id);
      const yVals = srcWires.map((w) => {
        if (inputs.includes(w.from)) return inputY.get(w.from) || START_Y;
        return gatePos.get(w.from)?.y ?? START_Y;
      });

      // Also check gate.inputs directly for unrouted inputs
      (gate.inputs || []).forEach((inp) => {
        if (inputs.includes(inp) && !yVals.some((v) => v === inputY.get(inp))) {
          yVals.push(inputY.get(inp) || START_Y);
        }
      });

      const avgY =
        yVals.length > 0
          ? yVals.reduce((a, b) => a + b, 0) / yVals.length
          : START_Y + gatesInCol.indexOf(gate) * ROW_SPACING;

      gatePos.set(gate.id, { x, y: Math.round(avgY) });
    });

    // Sort and enforce minimum row spacing
    gatesInCol.sort((a, b) => gatePos.get(a.id).y - gatePos.get(b.id).y);
    for (let i = 1; i < gatesInCol.length; i++) {
      const prevY = gatePos.get(gatesInCol[i - 1].id).y;
      const curr = gatePos.get(gatesInCol[i].id);
      if (curr.y - prevY < ROW_SPACING) {
        curr.y = prevY + ROW_SPACING;
      }
    }
  }

  const minY = Math.min(...inputY.values(), ...([...gatePos.values()].map((p) => p.y)));
  const textY = Math.max(80, minY - 40);

  return { inputX: INPUT_X, inputY, gatePos, textY };
}

function createElementRecord(scope, options) {
  const inputNodes = [];
  const outputNodes = [];

  for (let i = 0; i < options.inputCount; i += 1) {
    const offset = options.inputNodeOffset
      ? { x: options.inputNodeOffset.x, y: options.inputNodeOffset.y }
      : { x: -10, y: inputNodeOffset(i, options.inputCount) };
    inputNodes.push(addNode(scope, { x: offset.x, y: offset.y, type: 0 }));
  }

  for (let i = 0; i < options.outputCount; i += 1) {
    const offset = options.outputNodeOffset || { x: 20, y: 0 };
    outputNodes.push(addNode(scope, { x: offset.x, y: offset.y, type: 1 }));
  }

  const customNodes = {};
  if (inputNodes.length === 1) customNodes.inp1 = inputNodes[0];
  if (inputNodes.length > 1) customNodes.inp = inputNodes;
  if (outputNodes.length === 1) customNodes.output1 = outputNodes[0];

  const saveObject = {
    x: options.x,
    y: options.y,
    objectType: options.objectType,
    label: options.label || "",
    direction: options.direction || "RIGHT",
    labelDirection: options.labelDirection || "RIGHT",
    propagationDelay: options.propagationDelay !== undefined ? options.propagationDelay : 10,
    customData: {
      nodes: customNodes,
      constructorParamaters: options.constructorParamaters || ["RIGHT", 1]
    }
  };

  if (options.values) saveObject.customData.values = options.values;

  return { id: options.id, inputNodes, outputNodes, nextInputIndex: 0, saveObject };
}

function addNode(scope, node) {
  const index = scope.allNodes.length;
  scope.allNodes.push({ x: node.x, y: node.y, type: node.type, bitWidth: 1, label: "", connections: [] });
  return index;
}

function inputNodeOffset(index, count) {
  if (count === 1) return 0;
  return (index - (count - 1) / 2) * 20;
}

// Connects wires via type-2 wire nodes. Handles fan-out: when one output feeds
// multiple inputs, creates a junction wire node so all paths share a single branch point.
// Wire nodes are routed as orthogonal elbows so CircuitVerse draws horizontal/vertical
// segments instead of diagonal connector lines.
function connectCircuitVerseNodes(wires, registry, allNodes, scope) {
  // Group wires by source so fan-out creates one junction per source
  const bySource = new Map();
  wires.forEach((wire) => {
    if (!bySource.has(wire.from)) bySource.set(wire.from, []);
    bySource.get(wire.from).push(wire);
  });

  bySource.forEach((sourceWires, fromId) => {
    const from = registry.get(fromId);
    if (!from || !from.outputNodes.length) return;

    const sourceNodeIdx = from.outputNodes[0];
    const srcAbsX = from.saveObject.x + allNodes[sourceNodeIdx].x;
    const srcAbsY = from.saveObject.y + allNodes[sourceNodeIdx].y;

    const validWires = sourceWires.filter((w) => {
      const to = registry.get(w.to);
      return to && to.inputNodes.length > 0;
    });
    if (validWires.length === 0) return;

    if (validWires.length === 1) {
      const wire = validWires[0];
      const to = registry.get(wire.to);
      const targetNodeIdx = to.inputNodes[Math.min(to.nextInputIndex, to.inputNodes.length - 1)];
      to.nextInputIndex += 1;

      const tgtAbsX = to.saveObject.x + allNodes[targetNodeIdx].x;
      const tgtAbsY = to.saveObject.y + allNodes[targetNodeIdx].y;
      routeOrthogonalWire(sourceNodeIdx, srcAbsX, srcAbsY, targetNodeIdx, tgtAbsX, tgtAbsY, allNodes, scope);
    } else {
      // Fan-out: one junction wire node near the source, then branch wire nodes per target.
      // The junction is placed 20px right of the source output port.
      const junctionNodeIdx = addWireNode(allNodes, scope, srcAbsX + 20, srcAbsY);
      connectNodes(allNodes, sourceNodeIdx, junctionNodeIdx);

      validWires.forEach((wire, wireIndex) => {
        const to = registry.get(wire.to);
        const targetNodeIdx = to.inputNodes[Math.min(to.nextInputIndex, to.inputNodes.length - 1)];
        to.nextInputIndex += 1;

        const tgtAbsX = to.saveObject.x + allNodes[targetNodeIdx].x;
        const tgtAbsY = to.saveObject.y + allNodes[targetNodeIdx].y;
        const branchNodeIdx = addWireNode(allNodes, scope, srcAbsX + 20, tgtAbsY);
        connectNodes(allNodes, junctionNodeIdx, branchNodeIdx);
        connectNodes(allNodes, branchNodeIdx, targetNodeIdx);
      });
    }
  });
}

function routeOrthogonalWire(sourceNodeIdx, srcAbsX, srcAbsY, targetNodeIdx, tgtAbsX, tgtAbsY, allNodes, scope) {
  if (srcAbsY === tgtAbsY || srcAbsX === tgtAbsX) {
    connectNodes(allNodes, sourceNodeIdx, targetNodeIdx);
    return;
  }

  const routeX = Math.round(srcAbsX + Math.max(24, (tgtAbsX - srcAbsX) / 2));
  const cornerA = addWireNode(allNodes, scope, routeX, srcAbsY);
  const cornerB = addWireNode(allNodes, scope, routeX, tgtAbsY);

  connectNodes(allNodes, sourceNodeIdx, cornerA);
  connectNodes(allNodes, cornerA, cornerB);
  connectNodes(allNodes, cornerB, targetNodeIdx);
}

function addWireNode(allNodes, scope, x, y) {
  const nodeIdx = allNodes.length;
  allNodes.push({
    x: Math.round(x),
    y: Math.round(y),
    type: 2,
    bitWidth: 1,
    label: "",
    connections: []
  });
  scope.nodes.push(nodeIdx);
  return nodeIdx;
}

function connectNodes(allNodes, a, b) {
  if (!allNodes[a].connections.includes(b)) allNodes[a].connections.push(b);
  if (!allNodes[b].connections.includes(a)) allNodes[b].connections.push(a);
}

function mapGateToCircuitVerseElement(gate) {
  const typeMap = {
    NOT: "NotGate",
    AND: "AndGate",
    OR: "OrGate",
    XOR: "XorGate",
    OUTPUT: "Output",
    D_FLIP_FLOP: "DflipFlop"
  };
  return {
    id: gate.id,
    type: typeMap[gate.type] || gate.type,
    label: gate.label,
    x: gate.x,
    y: gate.y,
    inputs: gate.inputs || [],
    output: gate.output
  };
}

function validateCvCompatibility(cvContent) {
  if (!cvContent || String(cvContent).length < 20) {
    throw new Error("Generated .cv content is empty.");
  }
  const parsed = JSON.parse(String(cvContent));
  if (!parsed.name || !Array.isArray(parsed.scopes) || !parsed.scopes[0].allNodes) {
    throw new Error("Generated .cv content is missing CircuitVerse project scopes.");
  }
  return true;
}

function makeProjectId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function randomId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

module.exports = {
  generateCircuitVerseFile,
  generateExperimentalCvJson,
  mapGateToCircuitVerseElement,
  validateCvCompatibility
};
