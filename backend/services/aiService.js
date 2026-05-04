const { parseLogicQuestion } = require("./logicParser");
const { parseVhdl, looksLikeVhdl } = require("./vhdlParser");

function createClaudeClient() {
  const Anthropic = require("@anthropic-ai/sdk");
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY });
}

function createOpenAIClient() {
  const OpenAI = require("openai");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function claudeModel() {
  return process.env.CLAUDE_MODEL || "claude-sonnet-4-5";
}

function extractClaudeText(message) {
  return (message.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function coerceParsedCircuit(parsed, fallbackQuestion) {
  if (!parsed.inputs || !parsed.outputs || !parsed.expressions) {
    return parseLogicQuestion(fallbackQuestion);
  }
  return {
    type: parsed.type || "combinational",
    subtype: parsed.subtype || "ai",
    inputs: parsed.inputs,
    outputs: parsed.outputs,
    expressions: parsed.expressions,
    flipFlops: parsed.flipFlops || [],
    stateVariables: parsed.stateVariables || [],
    explanation: parsed.explanation || "",
    stateDiagram: parsed.stateDiagram || null,
    notes: parsed.notes || ""
  };
}

const CIRCUIT_EXTRACTION_PROMPT = `You are a digital logic circuit designer.
The user may describe a circuit in natural language ("create a half adder", "make a 3-input AND gate", "build a full adder"), provide Boolean expressions directly ("F = A + B"), provide VHDL source code, ask for a standard sequential circuit, or upload/read a truth table/state table/circuit diagram.
When given VHDL: parse the entity port declarations for input/output names, read the concurrent signal assignments (output <= expression), and convert VHDL operators (and→AND, or→OR, not→NOT, xor→XOR, nand→NOT(A AND B), nor→NOT(A OR B), xnor→NOT(A XOR B)) to produce correct Boolean expressions.
Extract or derive the circuit and return strict JSON only with keys:
type, subtype, inputs, outputs, expressions, flipFlops, stateVariables, stateDiagram, explanation, notes.
Use AND/OR/NOT/XOR operators in expressions.
For sequential circuits, return next-state D equations as outputs D0, D1, etc. Include stateVariables such as Q0 and Q1, and include flipFlops for each D output.
If the request asks to derive an expression from a circuit image, infer the gates and return the final Boolean expression.
If the request needs missing data (for example "given a truth table" without the truth table, "given a state table" without the table, or waveform analysis without a waveform/input sequence), explain the missing data in notes and still return the closest standard circuit only when one is clearly specified.
Do not include markdown.

Common circuits to recognise:
- Half adder: Sum=A XOR B, Carry=A AND B
- Half subtractor: Difference=A XOR B, Borrow=NOT A AND B
- Full adder: Sum=A XOR B XOR Cin, Cout=(A AND B) OR (Cin AND (A XOR B))
- 2-to-4 decoder with inputs A,B and outputs D0-D3: D0=NOT A AND NOT B, D1=NOT A AND B, D2=A AND NOT B, D3=A AND B
- AND gate (N inputs): F=A AND B [AND C...]
- OR gate (N inputs): F=A OR B [OR C...]
- Majority gate (3-input): F=(A AND B) OR (B AND C) OR (A AND C)
- 2:1 Multiplexer: F=(S AND B) OR (NOT S AND A)
- XNOR: F=NOT(A XOR B)
- D latch: treat as combinational with Q=D output
- 2-bit synchronous up counter with D flip-flops: D0=NOT Q0, D1=Q1 XOR Q0
- 2-bit synchronous down counter with D flip-flops: D0=NOT Q0, D1=Q1 XOR NOT Q0
- Mealy 101 detector with overlap: D1=Q0 AND NOT X, D0=X, Z=Q1 AND NOT Q0 AND X
- SISO 4-bit shift register: D0=SI, D1=Q0, D2=Q1, D3=Q2
- 4-bit parallel-load register: each Di=(L AND Pi) OR (NOT L AND Qi)`;

const NAMED_CIRCUITS = [
  {
    pattern: /(?:2\s*(?:-|to)\s*4|2.?to.?4|two.?to.?four).*decoder|decoder.*(?:2\s*(?:-|to)\s*4|2.?to.?4|two.?to.?four)/i,
    result: {
      type: "combinational", subtype: "2-to-4-decoder",
      inputs: ["A", "B"], outputs: ["D0", "D1", "D2", "D3"],
      expressions: {
        D0: "NOT A AND NOT B",
        D1: "NOT A AND B",
        D2: "A AND NOT B",
        D3: "A AND B"
      },
      flipFlops: [], stateVariables: [],
      explanation: "2-to-4 decoder: each output is one minterm of A and B. D0 is active for 00, D1 for 01, D2 for 10, and D3 for 11."
    }
  },
  {
    pattern: /half.?adder/i,
    result: {
      type: "combinational", subtype: "half-adder",
      inputs: ["A", "B"], outputs: ["Sum", "Carry"],
      expressions: { Sum: "A XOR B", Carry: "A AND B" },
      flipFlops: [], stateVariables: [],
      explanation: "Half adder: Sum is XOR of inputs, Carry is AND of inputs."
    }
  },
  {
    pattern: /full.?adder/i,
    result: {
      type: "combinational", subtype: "full-adder",
      inputs: ["A", "B", "Cin"], outputs: ["Sum", "Cout"],
      expressions: {
        Sum: "A XOR B XOR Cin",
        Cout: "(A AND B) OR (Cin AND (A XOR B))"
      },
      flipFlops: [], stateVariables: [],
      explanation: "Full adder: Sum uses XOR chain, Cout uses AND-OR carry logic."
    }
  },
  {
    pattern: /half.?subtractor/i,
    result: {
      type: "combinational", subtype: "half-subtractor",
      inputs: ["A", "B"], outputs: ["Difference", "Borrow"],
      expressions: { Difference: "A XOR B", Borrow: "NOT A AND B" },
      flipFlops: [], stateVariables: [],
      explanation: "Half subtractor: Difference is A XOR B, Borrow is A'B."
    }
  },
  {
    pattern: /majority/i,
    result: {
      type: "combinational", subtype: "majority-gate",
      inputs: ["A", "B", "C"], outputs: ["F"],
      expressions: { F: "(A AND B) OR (B AND C) OR (A AND C)" },
      flipFlops: [], stateVariables: [],
      explanation: "3-input majority gate: output is 1 when at least two inputs are 1."
    }
  },
  {
    pattern: /\bmux\b|multiplexer|2.?to.?1/i,
    result: {
      type: "combinational", subtype: "mux",
      inputs: ["A", "B", "S"], outputs: ["F"],
      expressions: { F: "(NOT S AND A) OR (S AND B)" },
      flipFlops: [], stateVariables: [],
      explanation: "2-to-1 multiplexer: S selects between inputs A and B."
    }
  },
  {
    pattern: /\bxnor\b/i,
    result: {
      type: "combinational", subtype: "xnor",
      inputs: ["A", "B"], outputs: ["F"],
      expressions: { F: "NOT (A XOR B)" },
      flipFlops: [], stateVariables: [],
      explanation: "XNOR gate: output is 1 when both inputs are equal."
    }
  },
  {
    pattern: /2.?bit.*synchronous.*up.*counter|2.?bit.*up.*counter/i,
    result: {
      type: "sequential", subtype: "2-bit-up-counter",
      inputs: ["Q0", "Q1"], outputs: ["D0", "D1"],
      expressions: { D0: "NOT Q0", D1: "Q1 XOR Q0" },
      flipFlops: ["D0", "D1"], stateVariables: ["Q0", "Q1"],
      stateDiagram: "00 -> 01 -> 10 -> 11 -> 00",
      explanation: "2-bit synchronous up counter using D flip-flops. D0 toggles every clock; D1 toggles when Q0 is 1."
    }
  },
  {
    pattern: /2.?bit.*synchronous.*down.*counter|2.?bit.*down.*counter/i,
    result: {
      type: "sequential", subtype: "2-bit-down-counter",
      inputs: ["Q0", "Q1"], outputs: ["D0", "D1"],
      expressions: { D0: "NOT Q0", D1: "Q1 XOR NOT Q0" },
      flipFlops: ["D0", "D1"], stateVariables: ["Q0", "Q1"],
      stateDiagram: "00 -> 11 -> 10 -> 01 -> 00",
      explanation: "2-bit synchronous down counter using D flip-flops. D0 toggles every clock; D1 toggles when Q0 is 0."
    }
  },
  {
    pattern: /sequence detector.*101|pattern.*101|detects? pattern 101/i,
    result: {
      type: "sequential", subtype: "mealy-101-detector",
      inputs: ["Q1", "Q0", "X"], outputs: ["D1", "D0", "Z"],
      expressions: { D1: "Q0 AND NOT X", D0: "X", Z: "Q1 AND NOT Q0 AND X" },
      flipFlops: ["D1", "D0"], stateVariables: ["Q1", "Q0"],
      stateDiagram: "S0(no match): 0/S0, 1/S1; S1(seen 1): 0/S2, 1/S1; S2(seen 10): 0/S0, 1/Z=1,S1",
      explanation: "Mealy sequence detector for pattern 101 with overlap. Output Z is asserted when state S2 receives X=1."
    }
  },
  {
    pattern: /pattern.*1101|detects? pattern 1101|1101.*overlap/i,
    result: {
      type: "sequential", subtype: "mealy-1101-detector",
      inputs: ["Q1", "Q0", "X"], outputs: ["D1", "D0", "Z"],
      expressions: {
        D1: "(Q1 AND NOT Q0) OR (NOT Q1 AND Q0 AND X)",
        D0: "(NOT Q1 AND NOT Q0 AND X) OR (Q1 AND NOT Q0 AND NOT X) OR (Q1 AND Q0 AND X)",
        Z: "Q1 AND Q0 AND X"
      },
      flipFlops: ["D1", "D0"], stateVariables: ["Q1", "Q0"],
      stateDiagram: "S0: 0/S0, 1/S1; S1: 0/S0, 1/S2; S2: 0/S3, 1/S2; S3: 0/S0, 1/Z=1,S1",
      explanation: "Mealy sequence detector for pattern 1101 with overlap. Z is asserted from the 110 state when X=1."
    }
  },
  {
    pattern: /serial.?in serial.?out|siso|shift register.*4|4.*d flip.?flops/i,
    result: {
      type: "sequential", subtype: "4-bit-siso-shift-register",
      inputs: ["SI", "Q0", "Q1", "Q2"], outputs: ["D0", "D1", "D2", "D3", "SO"],
      expressions: { D0: "SI", D1: "Q0", D2: "Q1", D3: "Q2", SO: "Q2" },
      flipFlops: ["D0", "D1", "D2", "D3"], stateVariables: ["Q0", "Q1", "Q2", "Q3"],
      explanation: "4-bit serial-in serial-out shift register. SI enters the first D flip-flop and each Q feeds the next D input."
    }
  },
  {
    pattern: /parallel load|parallel-load|register.*parallel/i,
    result: {
      type: "sequential", subtype: "4-bit-parallel-load-register",
      inputs: ["L", "P0", "P1", "P2", "P3", "Q0", "Q1", "Q2", "Q3"],
      outputs: ["D0", "D1", "D2", "D3"],
      expressions: {
        D0: "(L AND P0) OR (NOT L AND Q0)",
        D1: "(L AND P1) OR (NOT L AND Q1)",
        D2: "(L AND P2) OR (NOT L AND Q2)",
        D3: "(L AND P3) OR (NOT L AND Q3)"
      },
      flipFlops: ["D0", "D1", "D2", "D3"], stateVariables: ["Q0", "Q1", "Q2", "Q3"],
      explanation: "4-bit register with parallel load. L selects between new parallel inputs P0-P3 and feedback hold values Q0-Q3."
    }
  },
  {
    pattern: /jk.*toggle.*counter|toggle counter.*jk/i,
    result: {
      type: "sequential", subtype: "jk-toggle-counter",
      inputs: ["Q0"], outputs: ["J0", "K0", "J1", "K1"],
      expressions: { J0: "1", K0: "1", J1: "Q0", K1: "Q0" },
      flipFlops: [], stateVariables: ["Q0", "Q1"],
      explanation: "2-bit JK toggle counter. The least significant JK flip-flop toggles every clock; the next stage toggles when Q0 is 1."
    }
  },
  {
    pattern: /traffic light/i,
    result: {
      type: "sequential", subtype: "traffic-light-controller",
      inputs: ["Q1", "Q0"], outputs: ["D1", "D0", "Green", "Yellow", "Red"],
      expressions: {
        D1: "NOT Q1 AND Q0",
        D0: "NOT Q1 AND NOT Q0",
        Green: "NOT Q1 AND NOT Q0",
        Yellow: "NOT Q1 AND Q0",
        Red: "Q1 AND NOT Q0"
      },
      flipFlops: ["D1", "D0"], stateVariables: ["Q1", "Q0"],
      stateDiagram: "Green(00) -> Yellow(01) -> Red(10) -> Green(00)",
      explanation: "Simple three-state traffic light controller encoded with two D flip-flops."
    }
  }
];

function matchNamedCircuit(question) {
  for (const entry of NAMED_CIRCUITS) {
    if (entry.pattern.test(question)) return entry.result;
  }
  return null;
}

async function analyzeQuestion(question) {
  const named = matchNamedCircuit(question);
  if (named) return named;

  // Try VHDL parser before the AI — fast, reliable, no API call needed.
  if (looksLikeVhdl(question)) {
    try {
      return parseVhdl(question);
    } catch (error) {
      console.warn("VHDL parser could not handle input; falling back to AI.", error.message);
    }
  }

  if (looksLikeEquationInput(question)) {
    try {
      return parseLogicQuestion(question);
    } catch (error) {
      console.warn("Local equation parser failed; trying AI parser.", error.message);
    }
  }

  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) {
    try {
      const client = createClaudeClient();
      const message = await client.messages.create({
        model: claudeModel(),
        max_tokens: 1200,
        system: CIRCUIT_EXTRACTION_PROMPT,
        messages: [{ role: "user", content: question }]
      });
      return coerceParsedCircuit(JSON.parse(extractClaudeText(message)), question);
    } catch (error) {
      console.warn("Claude analysis failed; using fallback parser.", error.message);
    }
  }

  if (!process.env.OPENAI_API_KEY) return parseLogicQuestion(question);

  try {
    const client = createOpenAIClient();
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a digital logic circuit designer. The user may describe a circuit in natural language (\"create a half adder\", \"make a 3-input AND gate\", \"build a full adder\") OR provide Boolean expressions directly (\"F = A + B\"). In both cases extract or derive the circuit and return strict JSON only with keys: type, inputs, outputs, expressions (object mapping output name to Boolean expression), flipFlops, stateVariables, explanation. Use AND/OR/NOT/XOR operators. Do not include markdown.\n\nCommon circuits to recognise:\n- Half adder: Sum=A XOR B, Carry=A AND B\n- Full adder: Sum=A XOR B XOR Cin, Cout=(A AND B) OR (Cin AND (A XOR B))\n- AND gate (N inputs): F=A AND B [AND C...]\n- OR gate (N inputs): F=A OR B [OR C...]\n- Majority gate (3-input): F=(A AND B) OR (B AND C) OR (A AND C)\n- 2:1 Multiplexer: F=(S AND B) OR (NOT S AND A)\n- XNOR: F=NOT(A XOR B)\n- D latch: treat as combinational with Q=D output"
        },
        { role: "user", content: question }
      ]
    });
    return coerceParsedCircuit(JSON.parse(completion.choices[0].message.content), question);
  } catch (error) {
    console.warn("OpenAI analysis failed; using local parser.", error.message);
    return parseLogicQuestion(question);
  }
}

function looksLikeEquationInput(question) {
  return /(^|\n)\s*[A-Za-z][A-Za-z0-9_]*\s*=/.test(String(question || ""));
}

async function extractQuestionFromImage(file) {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) {
    const client = createClaudeClient();
    const response = await client.messages.create({
      model: process.env.CLAUDE_VISION_MODEL || claudeModel(),
      max_tokens: 1000,
      system:
        "You are an OCR and digital logic assistant. Read the image carefully. If it contains text, extract the student's exact Boolean logic problem. If it contains a logic circuit diagram, identify gates, inputs, outputs, and derive parseable Boolean equations when possible. Return strict JSON only with keys question, equations, notes, and confidence. Preserve apostrophes, XOR, plus signs, and line breaks. Make question parseable by the circuit generator, for example F = A'B + BC or Sum = A XOR B XOR Cin.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: file.mimetype,
                data: file.buffer.toString("base64")
              }
            },
            { type: "text", text: "Extract the equation(s), natural-language circuit request, or derived expression from this image." }
          ]
        }
      ]
    });
    const result = JSON.parse(extractClaudeText(response));
    return {
      question: String(result.question || "").trim(),
      equations: result.equations || [],
      notes: result.notes || "",
      confidence: result.confidence || null
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Image input requires ANTHROPIC_API_KEY so Claude can read the uploaded logic question.");
  }

  const client = createOpenAIClient();
  const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are an OCR and digital logic assistant. Read the image carefully. If it contains text, extract the student's exact Boolean logic problem. If it contains a logic circuit diagram, identify gates, inputs, outputs, and derive parseable Boolean equations when possible. Return strict JSON only with keys question, equations, notes, and confidence. Preserve apostrophes, XOR, plus signs, and line breaks. If the image says 'Create a circuit for F = A'B + AB'', return question as a parseable equation such as F = A'B + AB'."
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Read this logic question image and extract the equation(s) for circuit generation." },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ]
  });

  const result = JSON.parse(response.choices[0].message.content);
  return {
    question: String(result.question || "").trim(),
    equations: result.equations || [],
    notes: result.notes || "",
    confidence: result.confidence || null
  };
}

module.exports = { analyzeQuestion, extractQuestionFromImage };
