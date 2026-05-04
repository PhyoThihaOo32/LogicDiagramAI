function generateInstructions(parsed, circuitModel) {
  // Build a map from internal signal name to human-readable label.
  const signalLabel = new Map();
  parsed.inputs.forEach((name) => signalLabel.set(name, name));
  (circuitModel.gates || []).forEach((gate) => {
    if (gate.output) signalLabel.set(gate.output, gate.label || gate.id);
  });

  const readable = (signal) => signalLabel.get(signal) || cleanSignal(signal);

  const inputWord = parsed.inputs.length === 1 ? "pin" : "pins";
  const outputWord = parsed.outputs.length === 1 ? "pin" : "pins";
  const steps = [
    `Add input ${inputWord} ${joinList(parsed.inputs)}.`,
    `Add output ${outputWord} ${joinList(parsed.outputs)}.`
  ];

  if (parsed.stateDiagram) {
    steps.push(`Use this state diagram: ${parsed.stateDiagram}.`);
  }

  const notGates = circuitModel.gates.filter((gate) => gate.type === "NOT");
  const logicGates = circuitModel.gates.filter((gate) => ["AND", "OR", "XOR"].includes(gate.type));

  if (notGates.length) {
    steps.push(`Add NOT gates for inverted signals: ${joinList(notGates.map((gate) => gate.label))}.`);
    notGates.forEach((gate) => {
      steps.push(`Connect ${readable(gate.inputs[0])} to a NOT gate to produce ${gate.label}.`);
    });
  }

  logicGates.forEach((gate) => {
    steps.push(`Add a ${gate.type} gate for ${gate.label}.`);
    steps.push(`Connect ${joinList(gate.inputs.map(readable))} into the ${gate.type} gate.`);
  });

  if (parsed.type === "sequential") {
    steps.push("Add D flip-flops for each D output and connect each D equation output to the matching flip-flop D input.");
    steps.push("Connect a clock input to each D flip-flop and feed the Q outputs back to the state variable inputs.");
  }

  if (parsed.notes) {
    steps.push(`Note: ${parsed.notes}`);
  }

  parsed.outputs.forEach((output) => {
    steps.push(`Connect the final logic output to output ${outputWord.replace("pins","pin")} ${output}.`);
  });

  return steps.map((text, index) => `Step ${index + 1}: ${text}`);
}

function cleanSignal(signal) {
  return String(signal || "")
    .replace(/_not_\d+$/, "'")
    .replace(/_(out|\d+)$/g, "");
}

function joinList(items) {
  if (!items || items.length === 0) return "none";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function generateInstructionsText(instructions) {
  return instructions.join("\n");
}

module.exports = {
  generateInstructions,
  generateInstructionsText
};
