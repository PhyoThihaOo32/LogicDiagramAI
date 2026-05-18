const express = require("express");
const { generateDiagramSvg } = require("../services/circuitDiagramService");
const { generateInstructions, generateInstructionsText } = require("../services/circuitVerseInstructionService");
const { generateCircuitVerseFile } = require("../services/circuitVerseFileService");
const { exportTruthTableCsv } = require("../utils/csvExporter");
const { download } = require("../utils/fileHelpers");
const { generateVhdl } = require("../utils/vhdlGenerator");
const { analyzeQuestion } = require("../services/aiService");
const { generateTruthTable } = require("../services/truthTableService");
const { buildCircuitModel } = require("../services/circuitModelService");

const router = express.Router();

function requestBody(req) {
  if (req.body && req.body.payload) {
    try {
      return JSON.parse(req.body.payload);
    } catch (error) {
      throw new Error("Invalid export payload.");
    }
  }
  return req.body || {};
}

function exportError(res, err) {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ success: false, error: message });
}

/**
 * When an export endpoint receives only a `question` string (no pre-built
 * circuitModel / truthTable / diagramSvg), resolve it synchronously using the
 * local logic parser.  This avoids an AI round-trip for simple expressions and
 * named circuits handled by logicParser, while gracefully erroring for inputs
 * that require AI (those callers must use /api/analyze first).
 */
async function resolveFromQuestion(question) {
  const parsed = await analyzeQuestion(String(question).trim());
  const truthTable = generateTruthTable(parsed);
  const circuitModel = buildCircuitModel(parsed);
  const diagramSvg = generateDiagramSvg(circuitModel);
  const instructions = generateInstructions(parsed, circuitModel);
  return { parsed, truthTable, circuitModel, diagramSvg, instructions };
}

router.post("/svg", async (req, res) => {
  try {
    const body = requestBody(req);
    let svg = body.diagramSvg;
    if (!svg) {
      if (body.question) {
        const resolved = await resolveFromQuestion(body.question);
        svg = resolved.diagramSvg;
      } else {
        svg = generateDiagramSvg(body.circuitModel || {});
      }
    }
    download(res, "ai-generated-circuit.svg", "image/svg+xml", svg);
  } catch (err) { exportError(res, err); }
});

router.post("/cv", async (req, res) => {
  try {
    const body = requestBody(req);
    let model = body.circuitModel;
    if (!model && body.question) {
      const resolved = await resolveFromQuestion(body.question);
      model = resolved.circuitModel;
    }
    const cv = generateCircuitVerseFile(model || {});
    download(res, "ai-generated-circuit.cv", "application/octet-stream", cv);
  } catch (err) { exportError(res, err); }
});

router.post("/csv", async (req, res) => {
  try {
    const body = requestBody(req);
    let rows = body.truthTable;
    if ((!rows || !rows.length) && body.question) {
      const resolved = await resolveFromQuestion(body.question);
      rows = resolved.truthTable;
    }
    const csv = exportTruthTableCsv(rows || []);
    download(res, "truth-table.csv", "text/csv", csv);
  } catch (err) { exportError(res, err); }
});

router.post("/txt", async (req, res) => {
  try {
    const body = requestBody(req);
    let txt;
    if (body.instructions) {
      txt = Array.isArray(body.instructions)
        ? generateInstructionsText(body.instructions)
        : String(body.instructions);
    } else if (body.question) {
      const resolved = await resolveFromQuestion(body.question);
      txt = generateInstructionsText(resolved.instructions);
    } else {
      txt = "";
    }
    download(res, "logic-build-steps.txt", "text/plain", txt);
  } catch (err) { exportError(res, err); }
});

router.post("/json", async (req, res) => {
  try {
    const body = requestBody(req);
    let model = body.circuitModel;
    if (!model && body.question) {
      const resolved = await resolveFromQuestion(body.question);
      model = resolved.circuitModel;
    }
    const json = JSON.stringify(model || {}, null, 2);
    download(res, "internal-circuit-model.json", "application/json", json);
  } catch (err) { exportError(res, err); }
});

/**
 * POST /api/export/vhdl
 * Generates synthesisable VHDL source for the circuit.
 * Accepts either:
 *   { parsed }         – pre-parsed circuit object
 *   { question }       – raw question string (resolved via analyzeQuestion)
 *   { circuitModel }   – circuit model (expressions + inputs + outputs)
 */
router.post("/vhdl", async (req, res) => {
  try {
    const body = requestBody(req);
    let parsed = body.parsed;

    if (!parsed && body.question) {
      const resolved = await resolveFromQuestion(body.question);
      parsed = resolved.parsed;
    } else if (!parsed && body.circuitModel) {
      // circuitModel has inputs/outputs/expressions — usable as a parsed object
      parsed = body.circuitModel;
    }

    if (!parsed || !parsed.inputs || !parsed.outputs) {
      return res.status(400).json({
        success: false,
        error: "Provide either 'parsed', 'circuitModel', or 'question' in the request body."
      });
    }

    const vhdl = generateVhdl(parsed);
    download(res, "circuit.vhdl", "text/plain; charset=utf-8", vhdl);
  } catch (err) { exportError(res, err); }
});

module.exports = router;
