const express = require("express");
const multer = require("multer");
const { analyzeQuestion, extractQuestionFromImage } = require("../services/aiService");
const { generateTruthTable } = require("../services/truthTableService");
const { buildCircuitModel } = require("../services/circuitModelService");
const { generateDiagramSvg } = require("../services/circuitDiagramService");
const { generateInstructions } = require("../services/circuitVerseInstructionService");
const { createDownloadBundle } = require("../services/downloadBundleService");
const { parseExpression } = require("../utils/booleanEvaluator");
const { runAiCrossCheck } = require("../services/aiVerificationService");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!file.mimetype.startsWith("image/")) {
      return callback(new Error("Uploaded file must be an image."));
    }
    callback(null, true);
  }
});

function handleUpload(req, res, next) {
  upload.single("image")(req, res, (error) => {
    if (!error) return next();
    const message = error.code === "LIMIT_FILE_SIZE" ? "Image file is too large. Maximum size is 8 MB." : error.message;
    return res.status(400).json({ success: false, error: message });
  });
}

router.post("/analyze", handleUpload, async (req, res) => {
  try {
    let question = String(req.body.question || "").trim();
    let imageExtraction = null;
    if (req.file) {
      imageExtraction = await extractQuestionFromImage(req.file);
      question = imageExtraction.question || question;
    }

    if (!question) {
      return res.status(400).json({ success: false, error: "Question is required." });
    }

    const parsed = await analyzeQuestion(question);
    const cvAvailable = parsed.type !== "sequential";
    const truthTable = generateTruthTable(parsed);
    const circuitModel = buildCircuitModel(parsed);
    circuitModel.projectName = formatCircuitName(parsed);
    const diagramSvg = generateDiagramSvg(circuitModel);
    const instructions = generateInstructions(parsed, circuitModel);
    const simulatorCircuit = cvAvailable ? generateSimulatorCircuit(circuitModel) : null;
    const bundle = createDownloadBundle({ circuitModel, diagramSvg, truthTable, instructions, simulatorCircuit, cvAvailable });
    const verification = verifyParsed(parsed, truthTable);

    // ── AI cross-check ──────────────────────────────────────────────────────
    // Independent Claude call: given only the user's question + I/O names,
    // generate the expected truth table and compare with our locally-computed
    // one. Catches the case where Claude's expressions are wrong but
    // self-consistent (e.g. swapped Sum/Carry on a half adder).
    let aiCrossCheck = { skipped: true, reason: "No AI client configured" };
    if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) {
      try {
        const Anthropic = require("@anthropic-ai/sdk");
        const claudeClient = new Anthropic({
          apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY
        });
        const claudeModel = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";
        aiCrossCheck = await runAiCrossCheck({
          question,
          parsed,
          ourTruthTable: truthTable,
          claudeClient,
          claudeModel
        });
      } catch (error) {
        aiCrossCheck = { skipped: true, reason: `Cross-check error: ${error.message}` };
      }
    }
    verification.aiCrossCheck = aiCrossCheck;

    res.json({
      success: true,
      originalQuestion: question,
      imageExtraction,
      parsed,
      truthTable,
      verification,
      circuitModel,
      diagramSvg,
      instructions,
      simulatorCircuit,
      artifacts: bundle.artifacts,
      downloads: {
        cvAvailable,
        svgAvailable: true,
        jsonAvailable: true,
        csvAvailable: true,
        txtAvailable: true
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.all("/analyze", (req, res) => {
  res.status(405).json({
    success: false,
    error: `Method ${req.method} is not allowed for /api/analyze. Use POST.`
  });
});

function formatCircuitName(parsed) {
  if (parsed.subtype && parsed.subtype !== "general" && parsed.subtype !== "ai") {
    return parsed.subtype
      .split(/[-_ ]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  if (parsed.outputs && parsed.outputs.length === 1) {
    return `Circuit: ${parsed.outputs[0]}`;
  }
  return "AI Generated Circuit";
}

function generateSimulatorCircuit(circuitModel) {
  const { generateExperimentalCvJson } = require("../services/circuitVerseFileService");
  return generateExperimentalCvJson(circuitModel);
}

// ── Verification ──────────────────────────────────────────────────────────────
// Checks that the AI's parsed result is internally consistent and uses only
// declared inputs. Returns an object with verified:true/false + details.

function collectVars(ast) {
  if (!ast) return [];
  if (ast.type === "VAR") return [ast.name];
  if (ast.type === "CONST") return [];
  if (ast.type === "NOT") return collectVars(ast.value);
  return [...collectVars(ast.left || null), ...collectVars(ast.right || null)];
}

function verifyParsed(parsed, truthTable) {
  const outputs = parsed.outputs || [];
  const inputs = parsed.inputs || [];
  const expressions = parsed.expressions || {};
  const issues = [];

  // 1. Every declared output must have an expression
  for (const output of outputs) {
    if (!expressions[output]) {
      issues.push(`No expression provided for output "${output}"`);
    }
  }

  // 2. Every expression must parse cleanly and use only declared inputs
  for (const [output, expr] of Object.entries(expressions)) {
    if (!expr) continue;
    try {
      const ast = parseExpression(String(expr));
      const vars = [...new Set(collectVars(ast))];
      for (const v of vars) {
        if (!inputs.includes(v)) {
          issues.push(`Expression for "${output}" uses undeclared variable "${v}" (declared inputs: ${inputs.join(", ") || "none"})`);
        }
      }
    } catch (e) {
      issues.push(`Expression for "${output}" could not be parsed: ${e.message}`);
    }
  }

  // 3. Truth table must have rows (for circuits with ≤8 inputs)
  if (!truthTable.length && inputs.length > 0 && inputs.length <= 8) {
    issues.push("Truth table is empty despite having ≤8 inputs");
  }

  // 4. No null/undefined output cells in truth table
  let nullCount = 0;
  for (const row of truthTable) {
    for (const output of outputs) {
      if (row[output] === null || row[output] === undefined) nullCount += 1;
    }
  }
  if (nullCount > 0) {
    issues.push(`${nullCount} truth table cell(s) could not be evaluated`);
  }

  return {
    verified: issues.length === 0,
    rows: truthTable.length,
    outputCount: outputs.length,
    inputCount: inputs.length,
    issues,
    summary: issues.length === 0
      ? `All ${truthTable.length} row(s) × ${outputs.length} output(s) successfully evaluated from ${inputs.length} declared input(s).`
      : issues.join(" · ")
    // aiCrossCheck is attached after construction by the caller.
  };
}

module.exports = router;
