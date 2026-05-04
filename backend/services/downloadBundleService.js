const crypto = require("crypto");
const { exportTruthTableCsv } = require("../utils/csvExporter");
const { generateInstructionsText } = require("./circuitVerseInstructionService");

const bundles = new Map();

function createDownloadBundle({ circuitModel, diagramSvg, truthTable, instructions, simulatorCircuit, cvAvailable = true }) {
  const id = crypto.randomBytes(10).toString("hex");
  // Use the pre-computed simulatorCircuit JSON if provided; generate a fresh one as fallback.
  const cvContent =
    cvAvailable
      ? simulatorCircuit
        ? JSON.stringify(simulatorCircuit, null, 2)
        : (() => {
            const { generateExperimentalCvJson } = require("./circuitVerseFileService");
            return JSON.stringify(generateExperimentalCvJson(circuitModel || {}), null, 2);
          })()
      : null;
  const artifacts = {
    svg: {
      filename: "ai-generated-circuit.svg",
      contentType: "image/svg+xml",
      content: diagramSvg
    },
    csv: {
      filename: "truth-table.csv",
      contentType: "text/csv",
      content: exportTruthTableCsv(truthTable || [])
    },
    txt: {
      filename: "logic-build-steps.txt",
      contentType: "text/plain",
      content: generateInstructionsText(instructions || [])
    },
    json: {
      filename: "internal-circuit-model.json",
      contentType: "application/json",
      content: JSON.stringify(circuitModel || {}, null, 2)
    }
  };

  if (cvAvailable) {
    artifacts.cv = {
      filename: "ai-generated-circuit.cv",
      contentType: "application/octet-stream",
      content: cvContent
    };
  }

  bundles.set(id, artifacts);
  setTimeout(() => bundles.delete(id), 30 * 60 * 1000);

  return {
    id,
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([type, artifact]) => [
        type,
        {
          filename: artifact.filename,
          contentType: artifact.contentType,
          downloadUrl: `/api/download/${id}/${type}`
        }
      ])
    )
  };
}

function getArtifact(bundleId, type) {
  return bundles.get(bundleId)?.[type] || null;
}

module.exports = { createDownloadBundle, getArtifact };
