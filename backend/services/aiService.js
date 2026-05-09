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

// Robustly extract JSON from Claude output even when it wraps in ```json … ``` blocks.
function extractJson(text) {
  const s = text.trim();
  // 1. Direct parse
  try { return JSON.parse(s); } catch (_) {}
  // 2. Markdown code block
  const block = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block) { try { return JSON.parse(block[1].trim()); } catch (_) {} }
  // 3. First { ... } in text
  const start = s.indexOf("{");
  const end   = s.lastIndexOf("}");
  if (start !== -1 && end > start) { try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {} }
  throw new Error("Could not extract JSON from AI response: " + s.slice(0, 200));
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

const CIRCUIT_EXTRACTION_PROMPT = `You are a digital logic circuit designer and Boolean algebra expert.

INPUT FORMATS YOU ACCEPT:
- Natural language: "create a half adder", "make a 3-input AND gate", "4-to-1 multiplexer"
- Boolean expressions: "F = A'B + AB'", "Sum = A XOR B XOR Cin"
- VHDL source code: parse entity ports and concurrent signal assignments
- Truth tables / state tables: derive the minimal SOP expression for each output
- Circuit images: identify gates, inputs, outputs, derive Boolean expressions

VHDL conversion rules: and→AND, or→OR, not→NOT, xor→XOR, nand→NOT(... AND ...), nor→NOT(... OR ...), xnor→NOT(... XOR ...)

OUTPUT: Return strict JSON only — no markdown, no code fences, no extra text.
Required keys: type, subtype, inputs, outputs, expressions, flipFlops, stateVariables, stateDiagram, explanation, notes

EXPRESSION RULES (critical):
- Use ONLY AND / OR / NOT / XOR in expressions — never write NAND, NOR, XNOR as operators
- For NAND: write NOT(A AND B)
- For NOR:  write NOT(A OR B)
- For XNOR: write NOT(A XOR B)
- Parenthesise compound subexpressions clearly
- Variables are case-sensitive single letters or short names (A, B, Cin, Q0, SI)

SEQUENTIAL CIRCUITS:
- type="sequential", outputs are D flip-flop next-state equations named D0, D1, …
- Include stateVariables (Q0, Q1, …) in inputs
- Include flipFlops array listing each D-output name
- Add stateDiagram string showing state sequence

MISSING DATA:
- If user says "given a truth table" without providing one, explain in notes and return the closest named circuit

COMMON CIRCUITS (memorise these exactly):
Combinational:
- Half adder: inputs=[A,B] Sum=A XOR B, Carry=A AND B
- Half subtractor: inputs=[A,B] Difference=A XOR B, Borrow=NOT A AND B
- Full adder: inputs=[A,B,Cin] Sum=A XOR B XOR Cin, Cout=(A AND B) OR (Cin AND (A XOR B))
- Full subtractor: inputs=[A,B,Bin] Diff=A XOR B XOR Bin, Bout=((NOT A) AND B) OR ((NOT A) AND Bin) OR (B AND Bin)
- 2-to-4 decoder: inputs=[A,B] D0=NOT A AND NOT B, D1=NOT A AND B, D2=A AND NOT B, D3=A AND B
- 3-to-8 decoder: inputs=[A,B,C] D0=NOT A AND NOT B AND NOT C, … D7=A AND B AND C
- AND gate N-input: F=A AND B [AND C AND D …]
- OR gate N-input: F=A OR B [OR C …]
- NAND gate: F=NOT(A AND B)
- NOR gate: F=NOT(A OR B)
- XNOR gate: F=NOT(A XOR B)
- Majority gate (3-input): F=(A AND B) OR (B AND C) OR (A AND C)
- 2:1 Mux: inputs=[A,B,S] F=(NOT S AND A) OR (S AND B)
- 4:1 Mux: inputs=[D0,D1,D2,D3,S0,S1] F=(NOT S1 AND NOT S0 AND D0) OR (NOT S1 AND S0 AND D1) OR (S1 AND NOT S0 AND D2) OR (S1 AND S0 AND D3)
- 1-bit comparator: inputs=[A,B] EQ=NOT(A XOR B), GT=A AND NOT B, LT=NOT A AND B
- Even parity (3-input): inputs=[A,B,C] P=A XOR B XOR C
- Odd parity (3-input): inputs=[A,B,C] P=NOT(A XOR B XOR C)
- SR latch (NOR): inputs=[S,R] Q=NOT(R OR NOT Q_prev) — model as combinational Q=S AND NOT R
- D latch: inputs=[D,E] Q=D (treat as pass-through; E is enable, model Q=D for simplicity)
Sequential:
- 2-bit synchronous up counter: inputs=[Q0,Q1] D0=NOT Q0, D1=Q1 XOR Q0, stateDiagram=00->01->10->11->00
- 2-bit synchronous down counter: inputs=[Q0,Q1] D0=NOT Q0, D1=Q1 XOR NOT Q0, stateDiagram=00->11->10->01->00
- 3-bit up counter: inputs=[Q0,Q1,Q2] D0=NOT Q0, D1=Q1 XOR Q0, D2=Q2 XOR (Q1 AND Q0)
- Mealy 101 detector (overlap): inputs=[Q1,Q0,X] D1=Q0 AND NOT X, D0=X, Z=Q1 AND NOT Q0 AND X
- Mealy 1101 detector (overlap): as previously defined
- SISO 4-bit shift register: inputs=[SI,Q0,Q1,Q2] D0=SI, D1=Q0, D2=Q1, D3=Q2
- 4-bit parallel-load register: each Di=(L AND Pi) OR (NOT L AND Qi)
- JK toggle counter (2-bit): J0=1, K0=1, J1=Q0, K1=Q0`;

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
    pattern: /\bnand\b/i,
    result: {
      type: "combinational", subtype: "nand",
      inputs: ["A", "B"], outputs: ["F"],
      expressions: { F: "NOT (A AND B)" },
      flipFlops: [], stateVariables: [],
      explanation: "NAND gate: output is 0 only when all inputs are 1; otherwise 1."
    }
  },
  {
    pattern: /\bnor\b/i,
    result: {
      type: "combinational", subtype: "nor",
      inputs: ["A", "B"], outputs: ["F"],
      expressions: { F: "NOT (A OR B)" },
      flipFlops: [], stateVariables: [],
      explanation: "NOR gate: output is 1 only when all inputs are 0; otherwise 0."
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
    pattern: /full.?subtractor/i,
    result: {
      type: "combinational", subtype: "full-subtractor",
      inputs: ["A", "B", "Bin"], outputs: ["Diff", "Bout"],
      expressions: {
        Diff: "A XOR B XOR Bin",
        Bout: "((NOT A) AND B) OR ((NOT A) AND Bin) OR (B AND Bin)"
      },
      flipFlops: [], stateVariables: [],
      explanation: "Full subtractor: Diff is A XOR B XOR Bin, Borrow-out uses AND-OR logic on complemented A."
    }
  },
  {
    pattern: /4.?(?:to|:).?1\s*(?:mux|multiplexer)|4.?input.*mux/i,
    result: {
      type: "combinational", subtype: "4-to-1-mux",
      inputs: ["D0", "D1", "D2", "D3", "S0", "S1"], outputs: ["F"],
      expressions: {
        F: "(NOT S1 AND NOT S0 AND D0) OR (NOT S1 AND S0 AND D1) OR (S1 AND NOT S0 AND D2) OR (S1 AND S0 AND D3)"
      },
      flipFlops: [], stateVariables: [],
      explanation: "4-to-1 multiplexer: S1,S0 select one of four data inputs D0-D3."
    }
  },
  {
    pattern: /1.?bit\s+comparator|single.?bit\s+comparator|magnitude comparator/i,
    result: {
      type: "combinational", subtype: "1-bit-comparator",
      inputs: ["A", "B"], outputs: ["EQ", "GT", "LT"],
      expressions: {
        EQ: "NOT (A XOR B)",
        GT: "A AND NOT B",
        LT: "NOT A AND B"
      },
      flipFlops: [], stateVariables: [],
      explanation: "1-bit magnitude comparator: EQ when A equals B, GT when A>B, LT when A<B."
    }
  },
  {
    pattern: /even\s+parity|parity\s+generator|parity\s+checker/i,
    result: {
      type: "combinational", subtype: "even-parity",
      inputs: ["A", "B", "C"], outputs: ["P"],
      expressions: { P: "A XOR B XOR C" },
      flipFlops: [], stateVariables: [],
      explanation: "3-input even parity generator: output P makes the total number of 1s even."
    }
  },
  {
    pattern: /odd\s+parity/i,
    result: {
      type: "combinational", subtype: "odd-parity",
      inputs: ["A", "B", "C"], outputs: ["P"],
      expressions: { P: "NOT (A XOR B XOR C)" },
      flipFlops: [], stateVariables: [],
      explanation: "3-input odd parity generator: output P makes the total number of 1s odd."
    }
  },
  {
    pattern: /3.?to.?8\s*decoder|3.?bit.*decoder|eight.?output.*decoder/i,
    result: {
      type: "combinational", subtype: "3-to-8-decoder",
      inputs: ["A", "B", "C"], outputs: ["D0","D1","D2","D3","D4","D5","D6","D7"],
      expressions: {
        D0: "NOT A AND NOT B AND NOT C",
        D1: "NOT A AND NOT B AND C",
        D2: "NOT A AND B AND NOT C",
        D3: "NOT A AND B AND C",
        D4: "A AND NOT B AND NOT C",
        D5: "A AND NOT B AND C",
        D6: "A AND B AND NOT C",
        D7: "A AND B AND C"
      },
      flipFlops: [], stateVariables: [],
      explanation: "3-to-8 decoder: each of the 8 outputs is a unique minterm of A, B, C."
    }
  },
  {
    pattern: /3.?bit.*(?:synchronous\s+)?up.*counter|3.?bit.*counter/i,
    result: {
      type: "sequential", subtype: "3-bit-up-counter",
      inputs: ["Q0", "Q1", "Q2"], outputs: ["D0", "D1", "D2"],
      expressions: {
        D0: "NOT Q0",
        D1: "Q1 XOR Q0",
        D2: "Q2 XOR (Q1 AND Q0)"
      },
      flipFlops: ["D0", "D1", "D2"], stateVariables: ["Q0", "Q1", "Q2"],
      stateDiagram: "000 -> 001 -> 010 -> 011 -> 100 -> 101 -> 110 -> 111 -> 000",
      explanation: "3-bit synchronous up counter. D0 toggles every clock; D1 toggles when Q0=1; D2 toggles when Q1 and Q0 are both 1."
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
        max_tokens: 1400,
        // Cache the large system prompt so repeated requests don't re-tokenise it.
        system: [{ type: "text", text: CIRCUIT_EXTRACTION_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: question }]
      });
      return coerceParsedCircuit(extractJson(extractClaudeText(message)), question);
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
    return coerceParsedCircuit(extractJson(completion.choices[0].message.content), question);
  } catch (error) {
    console.warn("OpenAI analysis failed; using local parser.", error.message);
    return parseLogicQuestion(question);
  }
}

function looksLikeEquationInput(question) {
  const q = String(question || "");
  // Matches lines like "F = ...", "Sum = ...", "D0 = ..." and also
  // inline equations with Boolean operators after the = sign.
  return (
    /(^|\n)\s*[A-Za-z][A-Za-z0-9_]*\s*=\s*[^\s]/.test(q) &&
    /['+*&|^!~]|AND|OR|NOT|XOR|XNOR|NAND|NOR/i.test(q)
  );
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
    const result = extractJson(extractClaudeText(response));
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

  const result = extractJson(response.choices[0].message.content);
  return {
    question: String(result.question || "").trim(),
    equations: result.equations || [],
    notes: result.notes || "",
    confidence: result.confidence || null
  };
}

module.exports = { analyzeQuestion, extractQuestionFromImage };
