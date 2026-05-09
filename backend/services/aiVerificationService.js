// ─────────────────────────────────────────────────────────────────────────────
// AI cross-validation layer
//
// The main aiService extracts Boolean *expressions* from the user's question.
// We then compute a truth table from those expressions and draw a diagram from
// them.  But if Claude got the expressions wrong (e.g. swapped Sum/Carry on a
// half adder), every downstream artifact is consistently wrong and our existing
// verifyParsed() in analyzeRoutes only checks that the expressions parse — it
// never asks "is this actually what the user asked for?".
//
// This service closes that gap with an independent second Claude call.  It is
// shown the user's question and the input/output names *only* — never the
// expressions.  It produces what the truth table SHOULD look like.  We then
// compare row-by-row against the truth table our evaluator produced from the
// expressions.  Mismatches mean the expressions are wrong → flag to user.
// ─────────────────────────────────────────────────────────────────────────────

const VERIFICATION_PROMPT = `You are a digital logic verifier.

You will be given:
- A user's circuit request (in plain language, an equation, or VHDL)
- The list of input names (in order)
- The list of output names (in order)

Your job: independently produce the EXPECTED truth table for what the user is asking for.  Do NOT see or rely on any Boolean expressions — derive the truth table from the user's intent and standard digital-logic knowledge.

Output rules:
- Strict JSON only.  No markdown, no code fences, no prose.
- Format: { "rows": [ { "<input>": 0|1, ..., "<output>": 0|1, ... }, ... ] }
- Rows must be in standard binary count order.  With N inputs, row index i has input bit values equal to the binary expansion of i, where the FIRST input listed is the most-significant bit.  Total rows = 2^N.
- Every cell value must be exactly 0 or 1 (integers).
- Use the EXACT input and output names provided — do not rename, alias, or reorder them.
- For sequential circuits, treat the state variables (Q0, Q1, …) as inputs and the next-state D outputs as outputs.

If the user's request is ambiguous or you cannot produce a truth table with confidence, return { "rows": [], "uncertain": true, "reason": "..." } instead of guessing.`;

/**
 * Ask Claude to independently generate the expected truth table.
 * Returns { skipped: true, reason } or { skipped: false, aiRows, uncertain?, raw? }.
 */
async function aiGenerateExpectedTable({ question, parsed, claudeClient, claudeModel }) {
  if (!claudeClient) return { skipped: true, reason: "No Claude client configured" };

  const inputs = parsed.inputs || [];
  const outputs = parsed.outputs || [];

  if (inputs.length === 0 || outputs.length === 0) {
    return { skipped: true, reason: "No inputs/outputs to verify" };
  }
  if (inputs.length > 5) {
    // 32 rows × N outputs is the practical ceiling for a single response token budget.
    // Beyond that we save tokens and trust the local evaluator.
    return { skipped: true, reason: `Too many inputs (${inputs.length}) — cross-check skipped to save tokens` };
  }

  const userMessage = [
    `User question: "${question}"`,
    ``,
    `Circuit type: ${parsed.type || "combinational"}`,
    `Inputs (in order, MSB first): ${inputs.join(", ")}`,
    `Outputs (in order): ${outputs.join(", ")}`,
    ``,
    `Produce the expected truth table for what the user asked.  ${2 ** inputs.length} rows.`
  ].join("\n");

  try {
    const message = await claudeClient.messages.create({
      model: claudeModel,
      max_tokens: 1500,
      // Cache the verification prompt so repeated checks share the system tokens.
      system: [{ type: "text", text: VERIFICATION_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage }]
    });

    const text = (message.content || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim();

    const result = parseJsonLoose(text);
    if (!result) return { skipped: true, reason: "AI returned unparseable JSON", raw: text.slice(0, 300) };
    if (result.uncertain) return { skipped: true, reason: `AI declined: ${result.reason || "uncertain"}` };

    return {
      skipped: false,
      aiRows: Array.isArray(result.rows) ? result.rows : []
    };
  } catch (error) {
    return { skipped: true, reason: `AI verifier call failed: ${error.message}` };
  }
}

/** Tolerant JSON extraction — direct → markdown block → first {...} found. */
function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block) { try { return JSON.parse(block[1].trim()); } catch (_) {} }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

/**
 * Compare our locally-evaluated truth table with the AI's independent table.
 * Returns a structured result the frontend can render.
 */
function compareTruthTables(ourRows, aiRows, outputs) {
  if (!aiRows || aiRows.length === 0) return { compared: false };

  const ourLen = ourRows.length;
  const aiLen = aiRows.length;
  if (ourLen !== aiLen) {
    return {
      compared: true,
      match: false,
      mismatchCount: Math.abs(ourLen - aiLen),
      rowsCompared: 0,
      reason: `Row count differs — local=${ourLen}, AI=${aiLen}`,
      mismatches: []
    };
  }

  const mismatches = [];
  for (let i = 0; i < ourLen; i += 1) {
    for (const output of outputs) {
      const ours = Number(ourRows[i][output]);
      const ai = Number(aiRows[i][output]);
      if (Number.isNaN(ours) || Number.isNaN(ai)) continue;
      if (ours !== ai) {
        // Capture the input bit pattern so the UI can display readable rows.
        const inputBits = {};
        Object.keys(ourRows[i]).forEach((key) => {
          if (!outputs.includes(key)) inputBits[key] = ourRows[i][key];
        });
        mismatches.push({ rowIndex: i, output, ours, ai, inputs: inputBits });
      }
    }
  }

  return {
    compared: true,
    match: mismatches.length === 0,
    mismatchCount: mismatches.length,
    rowsCompared: ourLen,
    mismatches: mismatches.slice(0, 6) // cap for response size; UI can say "+N more"
  };
}

/**
 * Top-level helper called from the analyze route.
 * Returns one of:
 *   { skipped: true, reason }
 *   { skipped: false, compared: true, match: true,  rowsCompared, ... }
 *   { skipped: false, compared: true, match: false, mismatchCount, mismatches, ... }
 */
async function runAiCrossCheck({ question, parsed, ourTruthTable, claudeClient, claudeModel }) {
  // Sequential cross-check is harder (state encoding, initial state).
  // Skip for now — covered separately by stateDiagram inspection.
  if (parsed.type === "sequential") {
    return { skipped: true, reason: "Sequential circuits not yet cross-checked (relies on state diagram instead)" };
  }
  if (!ourTruthTable || ourTruthTable.length === 0) {
    return { skipped: true, reason: "No local truth table to compare against" };
  }

  const aiResult = await aiGenerateExpectedTable({ question, parsed, claudeClient, claudeModel });
  if (aiResult.skipped) return aiResult;

  const cmp = compareTruthTables(ourTruthTable, aiResult.aiRows, parsed.outputs || []);
  return { skipped: false, ...cmp };
}

module.exports = { runAiCrossCheck, compareTruthTables, aiGenerateExpectedTable };
