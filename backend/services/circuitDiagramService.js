function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateDiagramSvg(circuitModel) {
  const inputs = circuitModel.inputs || [];
  const gates = circuitModel.gates || [];
  const inputY = new Map(
    Object.entries(circuitModel.layout?.inputs || {}).length
      ? Object.entries(circuitModel.layout.inputs)
      : inputs.map((input, index) => [input, 110 + index * 90])
  );
  const nodeMap = new Map();
  const inputNodes = inputs.map((input) => {
    const node = { id: input, type: "INPUT", label: input, x: 34, y: Number(inputY.get(input) || 95) - 16, width: 70, height: 32 };
    nodeMap.set(input, node);
    return node;
  });

  gates.forEach((gate) => {
    nodeMap.set(gate.id, normalizeNode(gate));
  });

  // Also add CLK node if sequential and CLK was added to inputY but not in inputs array
  if (circuitModel.type === "sequential" && inputY.has("CLK") && !inputs.includes("CLK")) {
    const clkY = Number(inputY.get("CLK"));
    const clkNode = { id: "CLK", type: "INPUT", label: "CLK", x: 34, y: clkY - 16, width: 70, height: 32 };
    nodeMap.set("CLK", clkNode);
    inputNodes.push(clkNode);
  }

  const bounds = calculateBounds([...inputNodes, ...gates.map(normalizeNode)]);
  const width = Math.max(640, bounds.maxX + 56);
  const height = Math.max(340, bounds.maxY + 64);

  // Build a map from signal name to source node output anchor Y, so inputAnchor can
  // snap gate inputs to the wire's actual incoming Y and avoid upward-going wires.
  const signalSourceY = new Map();
  (circuitModel.wires || []).forEach((wire) => {
    const src = nodeMap.get(wire.from);
    if (src) {
      const anchor = outputAnchor(src);
      signalSourceY.set(wire.signal, anchor.y);
    }
  });

  const wires = (circuitModel.wires || [])
    .map((wire) => drawWire(wire, nodeMap, signalSourceY))
    .join("\n");
  const nodes = [...inputNodes, ...gates.map(normalizeNode)].map((n) => drawNode(n, signalSourceY)).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Generated circuit diagram">
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="#f0628a"/>
  </marker>
</defs>
<rect width="100%" height="100%" fill="#0a0a0a"/>
<text x="24" y="28" font-family="Arial" font-size="16" font-weight="700" fill="#f0628a" letter-spacing="2">${escapeXml(circuitModel.projectName || "AI Generated Circuit")}</text>
<text x="24" y="48" font-family="Arial" font-size="11" fill="#666666">${escapeXml(buildSubtitle(circuitModel))}</text>
${wires}
${nodes}
</svg>`;
}

function normalizeNode(node) {
  const sizes = {
    INPUT: [92, 36],
    OUTPUT: [76, 32],
    NOT: [58, 42],
    AND: [76, 50],
    OR: [82, 52],
    XOR: [88, 52],
    D_FLIP_FLOP: [104, 62]
  };
  const [width, height] = sizes[node.type] || [104, 58];
  return { ...node, width, height };
}

function calculateBounds(nodes) {
  return nodes.reduce(
    (bounds, node) => ({
      maxX: Math.max(bounds.maxX, (node.x || 0) + (node.width || 0)),
      maxY: Math.max(bounds.maxY, (node.y || 0) + (node.height || 0))
    }),
    { maxX: 0, maxY: 0 }
  );
}

function drawWire(wire, nodeMap, signalSourceY) {
  const from = nodeMap.get(wire.from);
  const to = nodeMap.get(wire.to);
  if (!from || !to) return "";

  const start = outputAnchor(from);
  const end = inputAnchor(to, wire.signal, signalSourceY);
  const path = wirePath(start, end);
  const label = wire.signal && !wire.signal.includes("_out") && !wire.signal.includes("_not_")
    ? `<text x="${start.x + 5}" y="${start.y - 5}" font-family="Arial" font-size="9" fill="#ff8cad">${escapeXml(wire.signal)}</text>`
    : "";

  return `<path d="${path}" stroke="#f0628a" stroke-width="1.8" fill="none" marker-end="url(#arrow)"/>
${label}`;
}

function wirePath(start, end) {
  // Straight line when Y difference is negligible
  if (Math.abs(start.y - end.y) <= 4) {
    return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  }

  // Feedback path, used for sequential circuits where a DFF Q output drives
  // next-state logic to its left. Route around the right side with 90-degree
  // elbows instead of drawing diagonal or crossing-through wires.
  if (start.x >= end.x) {
    const elbowX = start.x + 24;
    return `M ${start.x} ${start.y} L ${elbowX} ${start.y} L ${elbowX} ${end.y} L ${end.x} ${end.y}`;
  }

  // Elbow routing: go right from start, bend vertically, arrive at end.
  // Place the elbow column close to the target so the horizontal segment into
  // the gate is short and the long run stays on the source side.
  const elbowX = Math.max(start.x + 14, end.x - 20);
  return `M ${start.x} ${start.y} L ${elbowX} ${start.y} L ${elbowX} ${end.y} L ${end.x} ${end.y}`;
}

function outputAnchor(node) {
  // All node types: output exits from the right-centre edge.
  if (node.type === "NOT") return { x: node.x + node.width + 8, y: node.y + node.height / 2 };
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}

function inputAnchor(node, signal, signalSourceY) {
  const inputs = node.inputs || [];
  if (inputs.length <= 1) {
    // Single-input node: centre of left edge
    return { x: node.x, y: node.y + node.height / 2 };
  }

  const index = Math.max(0, inputs.indexOf(signal));

  // Prefer snapping to the actual source wire Y so the input tick aligns with
  // the incoming wire and prevents visually upward wires on tightly-spaced gates.
  if (signalSourceY && signalSourceY.has(signal)) {
    const srcY = signalSourceY.get(signal);
    // Clamp to the gate's vertical extent with a small margin so the tick stays on-gate
    const margin = 6;
    const clampedY = Math.max(node.y + margin, Math.min(node.y + node.height - margin, srcY));
    return { x: node.x, y: clampedY };
  }

  // Fallback: evenly distribute inputs within gate height
  const gap = node.height / (inputs.length + 1);
  return { x: node.x, y: node.y + gap * (index + 1) };
}

function drawNode(node, signalSourceY) {
  switch (node.type) {
    case "INPUT":
      return drawPin(node, "#1e0710", "#f0628a");
    case "OUTPUT":
      return drawPin(node, "#2a0f1a", "#f0628a");
    case "NOT":
      return drawNotGate(node);
    case "AND":
      return drawAndGate(node, signalSourceY);
    case "OR":
      return drawOrGate(node, false, signalSourceY);
    case "XOR":
      return drawOrGate(node, true, signalSourceY);
    case "D_FLIP_FLOP":
      return drawFlipFlop(node);
    default:
      return drawPin(node, "#1e0710", "#f0628a");
  }
}

function drawPin(node, fill, stroke) {
  const x = node.x;
  const y = node.y;
  const w = node.width;
  const h = node.height;
  return `<g>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
  <text x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="700" fill="#f0f0f0">${escapeXml(node.label || node.id)}</text>
</g>`;
}

function drawNotGate(node) {
  const x = node.x;
  const y = node.y;
  const h = node.height;
  const w = node.width - 10;
  return `<g>
  <path d="M ${x} ${y + 6} L ${x} ${y + h - 6} L ${x + w - 10} ${y + h / 2} Z" fill="#1e0710" stroke="#f0628a" stroke-width="1.5"/>
  <circle cx="${x + w - 2}" cy="${y + h / 2}" r="5" fill="#0a0a0a" stroke="#f0628a" stroke-width="1.5"/>
  <text x="${x + w / 2 - 5}" y="${y + h + 13}" text-anchor="middle" font-family="Arial" font-size="10" fill="#f0628a">${escapeXml(node.label)}</text>
</g>`;
}

function drawAndGate(node, signalSourceY) {
  const x = node.x;
  const y = node.y;
  const w = node.width;
  const h = node.height;
  return `<g>
  <path d="M ${x} ${y} L ${x + w * 0.52} ${y} C ${x + w} ${y}, ${x + w} ${y + h}, ${x + w * 0.52} ${y + h} L ${x} ${y + h} Z" fill="#1e0710" stroke="#f0628a" stroke-width="1.5"/>
  ${drawInputTicks(node, signalSourceY)}
  <text x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="700" fill="#f0628a">AND</text>
  <text x="${x + w / 2}" y="${y + h + 13}" text-anchor="middle" font-family="Arial" font-size="10" fill="#808080">${escapeXml(shortLabel(node.label))}</text>
</g>`;
}

function drawOrGate(node, isXor, signalSourceY) {
  const x = node.x;
  const y = node.y;
  const w = node.width;
  const h = node.height;
  const offset = isXor ? 9 : 0;
  const xorCurve = isXor ? `<path d="M ${x} ${y + 3} C ${x + 18} ${y + h / 2}, ${x + 18} ${y + h / 2}, ${x} ${y + h - 3}" fill="none" stroke="#f0628a" stroke-width="1.5"/>` : "";
  return `<g>
  ${xorCurve}
  <path d="M ${x + offset} ${y + 2} C ${x + w * 0.34} ${y + 4}, ${x + w * 0.75} ${y + 14}, ${x + w} ${y + h / 2} C ${x + w * 0.75} ${y + h - 14}, ${x + w * 0.34} ${y + h - 4}, ${x + offset} ${y + h - 2} C ${x + 20 + offset} ${y + h / 2}, ${x + 20 + offset} ${y + h / 2}, ${x + offset} ${y + 2} Z" fill="#1e0710" stroke="#f0628a" stroke-width="1.5"/>
  ${drawInputTicks(node, signalSourceY)}
  <text x="${x + w / 2 + 7}" y="${y + h / 2 + 5}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="700" fill="#f0628a">${isXor ? "XOR" : "OR"}</text>
  <text x="${x + w / 2}" y="${y + h + 13}" text-anchor="middle" font-family="Arial" font-size="10" fill="#808080">${escapeXml(shortLabel(node.label))}</text>
</g>`;
}

function drawInputTicks(node, signalSourceY) {
  const inputs = node.inputs || [];
  if (!inputs.length) return "";
  const margin = 6;
  // Use source Y if available so tick positions match wire endpoints exactly.
  return inputs
    .map((input) => {
      let tickY;
      if (signalSourceY && signalSourceY.has(input)) {
        const srcY = signalSourceY.get(input);
        tickY = Math.max(node.y + margin, Math.min(node.y + node.height - margin, srcY));
      } else {
        const gap = node.height / (inputs.length + 1);
        tickY = node.y + gap * (inputs.indexOf(input) + 1);
      }
      return `<line x1="${node.x - 7}" y1="${tickY}" x2="${node.x + 7}" y2="${tickY}" stroke="#f0628a" stroke-width="1.5"/><text x="${node.x - 9}" y="${tickY - 4}" text-anchor="end" font-family="Arial" font-size="9" fill="#ff8cad">${escapeXml(cleanSignal(input))}</text>`;
    })
    .join("");
}

function drawFlipFlop(node) {
  const x = node.x;
  const y = node.y;
  const w = node.width;
  const h = node.height;
  const inputs = node.inputs || [];
  // Draw D and CLK input labels on the left face, Q output label on the right
  const dLabel = inputs[0] ? cleanSignal(inputs[0]) : "D";
  return `<g>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#1e0710" stroke="#f0628a" stroke-width="1.5"/>
  <text x="${x + w / 2}" y="${y + 20}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="700" fill="#f0628a">DFF</text>
  <text x="${x + 6}" y="${y + 36}" font-family="Arial" font-size="10" fill="#ff8cad">D: ${escapeXml(dLabel)}</text>
  <text x="${x + 6}" y="${y + 50}" font-family="Arial" font-size="10" fill="#ff8cad">CLK &gt;</text>
  <text x="${x + w - 5}" y="${y + 36}" text-anchor="end" font-family="Arial" font-size="10" fill="#ff8cad">Q&gt;</text>
  <text x="${x + w / 2}" y="${y + h + 13}" text-anchor="middle" font-family="Arial" font-size="10" fill="#808080">${escapeXml(shortLabel(node.label))}</text>
</g>`;
}

function shortLabel(label) {
  const text = String(label || "");
  return text.length > 22 ? `${text.slice(0, 19)}...` : text;
}

function cleanSignal(signal) {
  return String(signal || "")
    .replace(/_not_\d+$/, "'")
    .replace(/_(out|\d+)$/g, "");
}

function buildSubtitle(circuitModel) {
  const inputs = (circuitModel.inputs || []).join(", ");
  const outputs = (circuitModel.outputs || []).join(", ");
  return `Inputs: ${inputs || "none"}   Outputs: ${outputs || "none"}`;
}

module.exports = { generateDiagramSvg };
