const express = require("express");
const multer = require("multer");
const { analyzeQuestion, extractQuestionFromImage } = require("../services/aiService");
const { generateTruthTable } = require("../services/truthTableService");
const { buildCircuitModel } = require("../services/circuitModelService");
const { generateDiagramSvg } = require("../services/circuitDiagramService");
const { generateInstructions } = require("../services/circuitVerseInstructionService");
const { createDownloadBundle } = require("../services/downloadBundleService");

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

    res.json({
      success: true,
      originalQuestion: question,
      imageExtraction,
      parsed,
      truthTable,
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

module.exports = router;
