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

  const allNodes = [...inputNodes, ...gates.map(normalizeNode)];

  const wires = (circuitModel.wires || [])
    .map((wire) => drawWire(wire, nodeMap, signalSourceY))
    .join("\n");
  const nodes = allNodes.map((n) => drawNode(n, signalSourceY)).join("\n");
  const junctions = buildJunctionDots(circuitModel.wires || [], nodeMap);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Generated circuit diagram">
<defs>
  <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="2.5" result="blur"/>
    <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<rect width="100%" height="100%" fill="#0a0a0a"/>
<rect x="0" y="0" width="${width}" height="56" fill="rgba(240,98,138,0.05)"/>
<line x1="0" y1="56" x2="${width}" y2="56" stroke="rgba(240,98,138,0.18)" stroke-width="1"/>
<text x="18" y="26" font-family="Arial" font-size="15" font-weight="800" fill="#f0628a" letter-spacing="1" filter="url(#glow)">${escapeXml(circuitModel.projectName || "AI Generated Circuit")}</text>
<text x="18" y="44" font-family="Arial" font-size="10" fill="#606070">${escapeXml(buildSubtitle(circuitModel))}</text>
${wires}
${nodes}
${junctions}
</svg>`;
}

const DIAGRAM_BASE = {
  INPUT: [92, 36], OUTPUT: [76, 32], NOT: [58, 42],
  AND: [76, 50], OR: [82, 52], XOR: [88, 52],
  NAND: [86, 50], NOR: [92, 52], XNOR: [98, 52],
  D_FLIP_FLOP: [104, 62]
};
const DIAGRAM_SCALABLE = new Set(["AND", "OR", "XOR", "NAND", "NOR", "XNOR"]);

function normalizeNode(node) {
  const [width, baseH] = DIAGRAM_BASE[node.type] || [104, 58];
  const n = (node.inputs || []).length;
  // Scale height by 16px for each input beyond 2 so all input ticks fit.
  const height = (DIAGRAM_SCALABLE.has(node.type) && n > 2) ? baseH + (n - 2) * 16 : baseH;
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
  // stroke-linecap=round + matching tick stroke-width (1.8) makes the wire-to-
  // tick handoff a single continuous segment with no thickness step or gap.
  return `<path d="${path}" stroke="#f0628a" stroke-width="1.8" fill="none" stroke-linecap="round"/>`;
}

// Gates that draw a 10-px input "tick" lead extending out the left of the body.
// For these the wire must end at the OUTER end of the tick so wire + tick form
// one continuous straight lead — otherwise the wire (1.8) overlaps the tick (1.5)
// inside the same 10-px region and the connection looks broken at the body edge.
const TICK_GATES = new Set(["AND", "OR", "XOR", "NAND", "NOR", "XNOR"]);

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
  if (node.type === "NOT") {
    // NOT gate: w = node.width - 10; bubble centre = x + w - 2; radius = 5
    // Right edge of bubble = x + (node.width - 10) - 2 + 5 = x + node.width - 7
    return { x: node.x + node.width - 7, y: node.y + node.height / 2 };
  }
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}

function inputAnchor(node, signal, signalSourceY) {
  const inputs = node.inputs || [];
  // XOR/XNOR gate body starts 9 px in from node.x due to the extra back-curve;
  // OR/NOR/AND/NAND start at node.x; NOT/OUTPUT have no tick.
  const bodyEdge = (node.type === "XOR" || node.type === "XNOR") ? node.x + 9 : node.x;
  // Tick length matches drawInputTicks() (10 px). Wire ends at OUTER end of
  // the tick so that wire + tick draw as one straight, continuous lead.
  const anchorX = TICK_GATES.has(node.type) ? bodyEdge - 10 : bodyEdge;

  if (inputs.length <= 1) {
    return { x: anchorX, y: node.y + node.height / 2 };
  }

  const margin = 6;

  if (signalSourceY && signalSourceY.has(signal)) {
    const srcY = signalSourceY.get(signal);
    const clampedY = Math.max(node.y + margin, Math.min(node.y + node.height - margin, srcY));
    return { x: anchorX, y: clampedY };
  }

  const index = Math.max(0, inputs.indexOf(signal));
  const gap = node.height / (inputs.length + 1);
  return { x: anchorX, y: node.y + gap * (index + 1) };
}

function drawNode(node, signalSourceY) {
  switch (node.type) {
    case "INPUT":
      // Green arrow pin pointing right — signal source
      return drawInputPin(node);
    case "OUTPUT":
      // Cyan notched pin — signal sink
      return drawOutputPin(node);
    case "NOT":
      return drawNotGate(node);
    case "AND":
      return drawAndGate(node, signalSourceY);
    case "OR":
      return drawOrGate(node, false, signalSourceY);
    case "XOR":
      return drawOrGate(node, true, signalSourceY);
    case "NAND":
      return drawNandGate(node, signalSourceY);
    case "NOR":
      return drawNorGate(node, signalSourceY);
    case "XNOR":
      return drawXnorGate(node, signalSourceY);
    case "D_FLIP_FLOP":
      return drawFlipFlop(node);
    case "CONST":
      return drawConstPin(node);
    default:
      return drawInputPin(node);
  }
}

// ── INPUT pin — pentagon arrow pointing right (green) ─────────────────────────
function drawInputPin(node) {
  const { x, y, width: w, height: h } = node;
  const tip = Math.min(11, h / 2 - 1);
  const label = escapeXml(node.label || node.id);
  return `<g>
  <path d="M ${x} ${y} L ${x+w-tip} ${y} L ${x+w} ${y+h/2} L ${x+w-tip} ${y+h} L ${x} ${y+h} Z"
        fill="#0d1f14" stroke="#10b981" stroke-width="1.6"/>
  <text x="${x+(w-tip)/2}" y="${y+h/2+4}" text-anchor="middle"
        font-family="Arial" font-size="11" font-weight="700" fill="#6ee7b7">${label}</text>
</g>`;
}

// ── OUTPUT pin — notched pentagon receiving from left (cyan) ──────────────────
function drawOutputPin(node) {
  const { x, y, width: w, height: h } = node;
  const notch = Math.min(11, h / 2 - 1);
  const label = escapeXml(node.label || node.id);
  return `<g>
  <path d="M ${x+notch} ${y} L ${x+w} ${y} L ${x+w} ${y+h} L ${x+notch} ${y+h} L ${x} ${y+h/2} Z"
        fill="#0d1825" stroke="#22d3ee" stroke-width="1.6"/>
  <text x="${x+notch+(w-notch)/2}" y="${y+h/2+4}" text-anchor="middle"
        font-family="Arial" font-size="11" font-weight="700" fill="#67e8f9">${label}</text>
</g>`;
}

// ── CONST pin — small grey rectangle ─────────────────────────────────────────
function drawConstPin(node) {
  const { x, y, width: w, height: h } = node;
  return `<g>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5"
        fill="#141414" stroke="#555" stroke-width="1.2"/>
  <text x="${x+w/2}" y="${y+h/2+4}" text-anchor="middle"
        font-family="Arial" font-size="12" font-weight="700" fill="#aaa">${escapeXml(node.label || node.id)}</text>
</g>`;
}

// ── Junction dots ─────────────────────────────────────────────────────────────
// Draws a filled dot wherever a signal fans out to 2+ targets.
function buildJunctionDots(wires, nodeMap) {
  const count = new Map();
  wires.forEach((w) => count.set(w.from, (count.get(w.from) || 0) + 1));
  const seen = new Set();
  const dots = [];
  wires.forEach((w) => {
    if ((count.get(w.from) || 0) < 2) return;
    const src = nodeMap.get(w.from);
    if (!src) return;
    const a = outputAnchor(src);
    const key = `${a.x},${a.y}`;
    if (seen.has(key)) return;
    seen.add(key);
    dots.push(`<circle cx="${a.x}" cy="${a.y}" r="3.5" fill="#f0628a"/>`);
  });
  return dots.join("\n");
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

// NAND gate = AND body + bubble on output.
// Body width = 76 (same AND path), bubble center at x+81, right edge at x+86 = node.width.
function drawNandGate(node, signalSourceY) {
  const x = node.x;
  const y = node.y;
  const bw = 76; // AND body width
  const h = node.height;
  const bcx = x + bw + 5; // bubble centre x
  const bcy = y + h / 2;
  return `<g>
  <path d="M ${x} ${y} L ${x + bw * 0.52} ${y} C ${x + bw} ${y}, ${x + bw} ${y + h}, ${x + bw * 0.52} ${y + h} L ${x} ${y + h} Z" fill="#1e0710" stroke="#f0628a" stroke-width="1.5"/>
  <circle cx="${bcx}" cy="${bcy}" r="5" fill="#0a0a0a" stroke="#f0628a" stroke-width="1.5"/>
  ${drawInputTicks(node, signalSourceY)}
  <text x="${x + bw * 0.38}" y="${y + h / 2 + 5}" text-anchor="middle" font-family="Arial" font-size="10" font-weight="700" fill="#f0628a">NAND</text>
  <text x="${x + bw / 2}" y="${y + h + 13}" text-anchor="middle" font-family="Arial" font-size="10" fill="#808080">${escapeXml(shortLabel(node.label))}</text>
</g>`;
}

// NOR gate = OR body + bubble on output.
// Body width = 82 (same OR path), bubble center at x+87, right edge at x+92 = node.width.
function drawNorGate(node, signalSourceY) {
  const x = node.x;
  const y = node.y;
  const bw = 82; // OR body width
  const h = node.height;
  const bcx = x + bw + 5; // bubble centre x
  const bcy = y + h / 2;
  return `<g>
  <path d="M ${x} ${y + 2} C ${x + bw * 0.34} ${y + 4}, ${x + bw * 0.75} ${y + 14}, ${x + bw} ${y + h / 2} C ${x + bw * 0.75} ${y + h - 14}, ${x + bw * 0.34} ${y + h - 4}, ${x} ${y + h - 2} C ${x + 20} ${y + h / 2}, ${x + 20} ${y + h / 2}, ${x} ${y + 2} Z" fill="#1e0710" stroke="#f0628a" stroke-width="1.5"/>
  <circle cx="${bcx}" cy="${bcy}" r="5" fill="#0a0a0a" stroke="#f0628a" stroke-width="1.5"/>
  ${drawInputTicks(node, signalSourceY)}
  <text x="${x + bw * 0.42}" y="${y + h / 2 + 5}" text-anchor="middle" font-family="Arial" font-size="10" font-weight="700" fill="#f0628a">NOR</text>
  <text x="${x + bw / 2}" y="${y + h + 13}" text-anchor="middle" font-family="Arial" font-size="10" fill="#808080">${escapeXml(shortLabel(node.label))}</text>
</g>`;
}

// XNOR gate = XOR body (with extra back-curve) + bubble on output.
// Body width = 88 (same XOR path), bubble center at x+93, right edge at x+98 = node.width.
function drawXnorGate(node, signalSourceY) {
  const x = node.x;
  const y = node.y;
  const bw = 88; // XOR body width
  const h = node.height;
  const offset = 9; // XOR back-curve offset
  const bcx = x + bw + 5;
  const bcy = y + h / 2;
  return `<g>
  <path d="M ${x} ${y + 3} C ${x + 18} ${y + h / 2}, ${x + 18} ${y + h / 2}, ${x} ${y + h - 3}" fill="none" stroke="#f0628a" stroke-width="1.5"/>
  <path d="M ${x + offset} ${y + 2} C ${x + bw * 0.34} ${y + 4}, ${x + bw * 0.75} ${y + 14}, ${x + bw} ${y + h / 2} C ${x + bw * 0.75} ${y + h - 14}, ${x + bw * 0.34} ${y + h - 4}, ${x + offset} ${y + h - 2} C ${x + 20 + offset} ${y + h / 2}, ${x + 20 + offset} ${y + h / 2}, ${x + offset} ${y + 2} Z" fill="#1e0710" stroke="#f0628a" stroke-width="1.5"/>
  <circle cx="${bcx}" cy="${bcy}" r="5" fill="#0a0a0a" stroke="#f0628a" stroke-width="1.5"/>
  ${drawInputTicks(node, signalSourceY)}
  <text x="${x + bw * 0.46}" y="${y + h / 2 + 5}" text-anchor="middle" font-family="Arial" font-size="10" font-weight="700" fill="#f0628a">XNOR</text>
  <text x="${x + bw / 2}" y="${y + h + 13}" text-anchor="middle" font-family="Arial" font-size="10" fill="#808080">${escapeXml(shortLabel(node.label))}</text>
</g>`;
}

function drawInputTicks(node, signalSourceY) {
  const inputs = node.inputs || [];
  if (!inputs.length) return "";
  const margin = 6;
  // XOR/XNOR gate body starts 9px in; AND/NAND/OR/NOR bodies start at node.x
  const edgeX = (node.type === "XOR" || node.type === "XNOR") ? node.x + 9 : node.x;
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
      // Tick stroke width and linecap match drawWire so the wire's terminal
      // butt-cap at (edgeX-10) joins the tick into a single continuous segment.
      return `<line x1="${edgeX - 10}" y1="${tickY}" x2="${edgeX}" y2="${tickY}" stroke="#f0628a" stroke-width="1.8" stroke-linecap="round"/>`;
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
  const inputs  = (circuitModel.inputs  || []).join(", ") || "none";
  const outputs = (circuitModel.outputs || []).join(", ") || "none";
  const gateCount = (circuitModel.gates || []).filter((g) => !["OUTPUT", "CONST"].includes(g.type)).length;
  const typeLabel = circuitModel.type === "sequential" ? "Sequential" : "Combinational";
  return `${typeLabel}  ·  Inputs: ${inputs}  ·  Outputs: ${outputs}  ·  ${gateCount} gate${gateCount !== 1 ? "s" : ""}`;
}

module.exports = { generateDiagramSvg };
