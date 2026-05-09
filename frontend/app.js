const state = {
  analysis: null,
  downloadUrls: [],
  simulatorRetryTimers: [],
  simulatorFrameLoaded: false,
  simulatorLoadListener: null
};
// Use relative URLs when served by any http/https server (works locally on any port
// and in production on Railway/Render/etc.).
// Only fall back to the absolute local address when opened directly as a file://.
const API_BASE = window.location.protocol === "file:" ? "http://127.0.0.1:3000" : "";

const question = document.querySelector("#question");
const imageInput = document.querySelector("#imageInput");
const imageName = document.querySelector("#imageName");
const analyzeBtn = document.querySelector("#analyzeBtn");
const statusBox = document.querySelector("#status");
const results = document.querySelector("#results");
const charHint = document.querySelector("#charHint");
document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab));
});

analyzeBtn.addEventListener("click", analyze);
imageInput.addEventListener("change", () => {
  imageName.textContent = imageInput.files[0] ? imageInput.files[0].name : "No image selected";
});

// Quick-fill example chips
document.querySelectorAll(".chip[data-fill]").forEach((chip) => {
  chip.addEventListener("click", () => {
    question.value = chip.dataset.fill;
    question.focus();
    updateCharHint();
  });
});

// Keyboard shortcut: Ctrl/Cmd + Enter to generate
document.addEventListener("keydown", (e) => {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  if ((isMac ? e.metaKey : e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (!analyzeBtn.disabled) analyze();
  }
});

// Show ⌘↵ on Mac, Ctrl↵ on other OS
(function setKbdHint() {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const hint = document.querySelector(".kbd-hint");
  if (hint && !isMac) {
    hint.innerHTML = "<kbd>Ctrl</kbd><kbd>↵</kbd>";
  }
})();

// Char counter under textarea
function updateCharHint() {
  if (!charHint) return;
  const len = question.value.length;
  if (len === 0) { charHint.textContent = ""; return; }
  charHint.textContent = `${len} char${len !== 1 ? "s" : ""}`;
  charHint.classList.toggle("warn", len > 800);
}
question.addEventListener("input", updateCharHint);
updateCharHint();

if (window.location.protocol === "file:") {
  setStatus("Running from a local file. The app will use the backend at http://127.0.0.1:3000; for the most reliable experience, open that URL directly.");
}

function setAnalyzeLoading(loading) {
  analyzeBtn.disabled = loading;
  analyzeBtn.querySelector(".btn-text").hidden = loading;
  analyzeBtn.querySelector(".btn-loader").hidden = !loading;
}

async function analyze(event) {
  if (event) event.preventDefault();
  setStatus(imageInput.files[0] ? "Reading image and generating circuit..." : "Generating circuit...");
  setAnalyzeLoading(true);
  try {
    const form = new FormData();
    form.append("question", question.value);
    if (imageInput.files[0]) form.append("image", imageInput.files[0]);
    const response = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST",
      body: form
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.success) throw new Error(data.error || "Analysis failed.");
    state.analysis = data;
    if (data.imageExtraction && data.imageExtraction.question) {
      question.value = data.imageExtraction.question;
      updateCharHint();
    }
    renderResults(data);
    setStatus("");
    results.hidden = false;
    // Smooth scroll to results
    window.setTimeout(() => results.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setAnalyzeLoading(false);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`Server returned an empty response (${response.status}).`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Server returned non-JSON response (${response.status}): ${text.slice(0, 180)}`);
  }
}

function renderResults(data) {
  renderSummary(data);
  renderTruthTable(data.truthTable, data.verification);
  document.querySelector("#steps").innerHTML = `<ol>${data.instructions.map((step) => `<li>${escapeHtml(step.replace(/^Step \d+:\s*/, ""))}</li>`).join("")}</ol>`;
  renderDownloads(data);
  renderSimulatorPanel(data);
  // If the simulator frame is already loaded (user visited the tab earlier), update it immediately.
  if (data.parsed?.type !== "sequential" && state.simulatorFrameLoaded) loadSimulator(data);
  activateTab("summary");
}

function loadSimulator(data) {
  if (data?.parsed?.type === "sequential") return;
  if (!data || !data.simulatorCircuit) return;
  const iframe = document.querySelector("#cvSimulator");
  if (!iframe) return;

  // Cancel any pending retry timers from previous circuit
  state.simulatorRetryTimers.forEach((timer) => window.clearTimeout(timer));
  state.simulatorRetryTimers = [];

  // Remove any stale load listener to prevent stacking when called repeatedly
  if (state.simulatorLoadListener) {
    iframe.removeEventListener("load", state.simulatorLoadListener);
    state.simulatorLoadListener = null;
  }

  const send = () => {
    if (!iframe.contentWindow) return;
    iframe.contentWindow.postMessage({ type: "loadCircuit", circuitData: data.simulatorCircuit }, "*");
  };

  const sendWithRetries = () => {
    state.simulatorLoadListener = null;
    [0, 700, 1500].forEach((delay) => {
      const timer = window.setTimeout(send, delay);
      state.simulatorRetryTimers.push(timer);
    });
  };

  const simulatorUrl = `${API_BASE || window.location.origin}/simulator/`;
  if (iframe.src !== simulatorUrl) {
    state.simulatorFrameLoaded = false;
    iframe.src = simulatorUrl;
  }

  if (state.simulatorFrameLoaded) {
    sendWithRetries();
  } else {
    state.simulatorLoadListener = sendWithRetries;
    iframe.addEventListener("load", sendWithRetries, { once: true });
  }
}

function renderSimulatorPanel(data) {
  const panel = document.querySelector("#simulator");
  if (!panel) return;

  if (data.parsed?.type === "sequential") {
    state.simulatorRetryTimers.forEach((timer) => window.clearTimeout(timer));
    state.simulatorRetryTimers = [];
    state.simulatorFrameLoaded = false;
    panel.innerHTML = `
      <div class="simulator-fallback">
      <div class="notice">
        <strong>Sequential simulator note.</strong>
        The generated logic is a state-machine diagram. CircuitVerse simulation needs explicit D flip-flop feedback and an initial reset state, so the embedded experimental importer is disabled for this case to avoid showing invalid red/X wiring.
      </div>
      <div class="grid">
        <div class="card">
          <h3>Expected State Sequence</h3>
          <p>${escapeHtml(data.parsed.stateDiagram || "Use the D equations and truth table to step the state bits on each clock edge.")}</p>
        </div>
        <div class="card">
          <h3>Initial State</h3>
          <p>${buildInitialStateHint(data.parsed)}</p>
        </div>
      </div>
      <div class="svg-wrap">${data.diagramSvg}</div>
      </div>
    `;
    return;
  }

  panel.innerHTML = `
    <div class="sim-controls">
      <button type="button" id="simFitBtn"     title="Fit circuit to screen (F)">&#x26F6; Fit</button>
      <button type="button" id="simZoomInBtn"  title="Zoom in (+)">+ Zoom In</button>
      <button type="button" id="simZoomOutBtn" title="Zoom out (−)">− Zoom Out</button>
      <span class="sim-hint-label">Scroll to zoom &nbsp;·&nbsp; Drag canvas to pan</span>
    </div>
    <iframe id="cvSimulator" src="about:blank" title="CircuitVerse Simulator" allowfullscreen></iframe>`;

  // Wire up control bar buttons → postMessage into the iframe
  const simCmd = (type) => {
    const fr = document.querySelector("#cvSimulator");
    if (fr && fr.contentWindow) fr.contentWindow.postMessage({ type }, "*");
  };
  document.querySelector("#simFitBtn").addEventListener("click", () => simCmd("simFit"));
  document.querySelector("#simZoomInBtn").addEventListener("click", () => simCmd("simZoomIn"));
  document.querySelector("#simZoomOutBtn").addEventListener("click", () => simCmd("simZoomOut"));
}

function renderSummary(data) {
  const parsed = data.parsed;
  const stateVariables = parsed.stateVariables || [];
  const externalInputs = data.circuitModel?.inputs || parsed.inputs || [];
  const visibleOutputs = (data.circuitModel?.gates || [])
    .filter((gate) => gate.type === "OUTPUT")
    .map((gate) => gate.label);
  const miniChip = buildMiniVerifyChip(data.verification);
  document.querySelector("#summary").innerHTML = `
    ${miniChip}
    <div class="grid">
      <div class="card"><h3>Type</h3><p>${escapeHtml(parsed.type)}${parsed.subtype ? ` / ${escapeHtml(parsed.subtype)}` : ""}</p></div>
      <div class="card"><h3>External Inputs</h3><p>${escapeHtml(externalInputs.join(", ") || "none")}</p></div>
      <div class="card"><h3>${parsed.type === "sequential" ? "State / Equations" : "Outputs"}</h3><p>${escapeHtml(parsed.outputs.join(", "))}</p></div>
      ${stateVariables.length ? `<div class="card"><h3>State Variables</h3><p>${escapeHtml(stateVariables.join(", "))}</p></div>` : ""}
      ${visibleOutputs.length && parsed.type === "sequential" ? `<div class="card"><h3>Visible Outputs</h3><p>${escapeHtml(visibleOutputs.join(", "))}</p></div>` : ""}
    </div>
    <h3>Expressions</h3>
    <pre>${escapeHtml(JSON.stringify(parsed.expressions, null, 2))}</pre>
    ${data.imageExtraction ? `<h3>Image Extraction</h3><div class="card"><p><strong>Extracted question:</strong> ${escapeHtml(data.imageExtraction.question || "(none)")}</p>${data.imageExtraction.confidence !== undefined ? `<p><strong>Confidence:</strong> ${escapeHtml(String(data.imageExtraction.confidence))}</p>` : ""}${data.imageExtraction.notes ? `<p><strong>Notes:</strong> ${escapeHtml(data.imageExtraction.notes)}</p>` : ""}</div>` : ""}
    <h3>Circuit Diagram</h3>
    <div class="svg-wrap">${data.diagramSvg}</div>
    ${parsed.stateDiagram ? `<h3>State Diagram</h3><pre>${escapeHtml(parsed.stateDiagram)}</pre>` : ""}
  `;
}

function buildMiniVerifyChip(verification) {
  if (!verification) return "";
  const ai = verification.aiCrossCheck;
  const graph = verification.modelGraphCheck;
  const corrected = verification.autoCorrected ? `<span class="auto-fix-tag">Auto-corrected by AI</span>` : "";

  // ── AI cross-check disagreement is the most important failure signal.
  if (ai && !ai.skipped && ai.compared && ai.match === false) {
    return `<div class="verify-chip failed">⚠ AI cross-check disagreed on ${escapeHtml(String(ai.mismatchCount))} of ${escapeHtml(String(ai.rowsCompared))} rows &mdash; the chosen expressions may not match what you asked for. See the Truth Table tab for the disputed rows.</div>`;
  }

  // ── Model graph simulation found a wiring bug (rare; means buildCircuitModel
  //    produced a graph that doesn't compute what the expressions say).
  if (graph && !graph.skipped && graph.verified === false) {
    return `<div class="verify-chip failed">⚠ Diagram does not match expressions on ${escapeHtml(String(graph.issueCount))} of ${escapeHtml(String(graph.rowsTested))} rows &mdash; the SVG wiring may be incorrect even though the truth table is right. Please report this circuit.</div>`;
  }

  // ── Strongest signal: AI cross-check passed AND graph simulation passed.
  if (verification.verified && ai && !ai.skipped && ai.compared && ai.match && graph && !graph.skipped && graph.verified) {
    return `<div class="verify-chip verified">✓ Triple-verified &mdash; expressions parse, gate graph simulates correctly across all ${escapeHtml(String(graph.rowsTested))} rows, and an independent Claude call agreed on every output. ${corrected}</div>`;
  }
  if (verification.verified && ai && !ai.skipped && ai.compared && ai.match) {
    return `<div class="verify-chip verified">✓ Double-verified by independent AI cross-check &mdash; all ${escapeHtml(String(ai.rowsCompared))} rows match a second Claude derivation. ${corrected}</div>`;
  }
  if (verification.verified) {
    const reason = ai && ai.skipped ? ` (AI cross-check skipped: ${escapeHtml(ai.reason || "n/a")})` : "";
    return `<div class="verify-chip verified">✓ Logic verified &mdash; expressions evaluated cleanly across all ${escapeHtml(String(verification.rows))} rows${reason}. ${corrected}</div>`;
  }
  return `<div class="verify-chip failed">⚠ Verification found issues &mdash; check the Truth Table tab for details.</div>`;
}

function renderTruthTable(rows, verification) {
  const badge = buildVerifyBadge(verification);
  if (!rows.length) {
    document.querySelector("#truth").innerHTML = `${badge}<p>No rows generated.</p>`;
    return;
  }
  const headers = Object.keys(rows[0]);
  const inputCols = headers.length > 1 ? headers.slice(0, -1) : [];
  const outputCols = headers.length > 1 ? headers.slice(-1) : headers;
  document.querySelector("#truth").innerHTML = `
    ${badge}
    <div class="table-wrap">
      <table>
        <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
        <tbody>
          ${rows.map((row) => `<tr>${headers.map((h, i) => {
            const val = String(row[h] ?? "");
            const isOut = i === headers.length - 1 && headers.length > 1;
            return `<td${isOut ? ` data-output="${escapeHtml(val)}"` : ""}>${escapeHtml(val)}</td>`;
          }).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function buildVerifyBadge(verification) {
  if (!verification) return "";
  const ai = verification.aiCrossCheck;
  const graph = verification.modelGraphCheck;
  const aiBlock = buildAiCrossCheckBlock(ai);
  const graphBlock = buildGraphCheckBlock(graph);
  const corrected = verification.autoCorrected
    ? `<div class="auto-fix-banner">🔧 The original AI answer disagreed with the expected truth table — Claude was asked to correct itself with the disputed rows as feedback. The corrected version is shown below.</div>`
    : "";

  if (ai && !ai.skipped && ai.compared && ai.match === false) {
    return `<div class="verify-badge failed">⚠ AI CROSS-CHECK DISAGREED &mdash; ${escapeHtml(String(ai.mismatchCount))} of ${escapeHtml(String(ai.rowsCompared))} rows differ between the locally-evaluated truth table and an independent Claude derivation.${aiBlock}${graphBlock}</div>`;
  }
  if (graph && !graph.skipped && graph.verified === false) {
    return `<div class="verify-badge failed">⚠ DIAGRAM DOES NOT MATCH EXPRESSIONS &mdash; the gate graph simulation diverged from the truth table on ${escapeHtml(String(graph.issueCount))} row(s).${graphBlock}${aiBlock}</div>`;
  }
  if (verification.verified && ai && !ai.skipped && ai.compared && ai.match && graph && !graph.skipped && graph.verified) {
    return `<div class="verify-badge verified">${corrected}✓ TRIPLE-VERIFIED &mdash; expressions parse, gate graph simulates correctly across ${escapeHtml(String(graph.rowsTested))} row(s), and an independent Claude call agreed on every output.${aiBlock}${graphBlock}</div>`;
  }
  if (verification.verified && ai && !ai.skipped && ai.compared && ai.match) {
    return `<div class="verify-badge verified">${corrected}✓ DOUBLE-VERIFIED &mdash; expressions evaluate cleanly AND an independent Claude call agreed on all ${escapeHtml(String(ai.rowsCompared))} rows.${aiBlock}${graphBlock}</div>`;
  }
  if (verification.verified) {
    return `<div class="verify-badge verified">${corrected}✓ VERIFIED &mdash; ${escapeHtml(verification.summary)}${aiBlock}${graphBlock}</div>`;
  }
  const issueList = (verification.issues || []).map((i) => `<li>${escapeHtml(i)}</li>`).join("");
  return `<div class="verify-badge failed">⚠ ISSUES DETECTED &mdash; ${escapeHtml(verification.summary)}${issueList ? `<ul>${issueList}</ul>` : ""}${aiBlock}${graphBlock}</div>`;
}

function renderDownloads(data) {
  clearDownloadUrls();
  const links = buildDownloadLinks(data);
  const isSequential = data.parsed?.type === "sequential";

  const downloadsTab = document.querySelector("#downloads");
  downloadsTab.innerHTML = `
    <div class="notice">
      <strong>Stable exports.</strong> Download the generated diagram, truth table, build steps, or internal circuit model.
      ${isSequential ? " Sequential CircuitVerse .cv export is hidden because D flip-flop feedback import is not reliable yet." : " CircuitVerse .cv export is experimental and should be verified in CircuitVerse."}
    </div>
    <div class="downloads">
      ${links.map((link) => `<a class="download-button" href="${link.url}" download="${link.filename}" target="_blank" data-artifact="${link.type}"><span class="dl-icon">${dlIcon(link.type)}</span>${link.label}</a>`).join("")}
    </div>
    <div id="manualDownload" class="manual-download" hidden></div>
    <div class="card">
      <h3>Recommended workflow</h3>
      <ol>
        <li>Review the generated diagram for the parsed expression.</li>
        <li>Download the SVG diagram for submission or reference.</li>
        <li>Download the truth table CSV to verify output behavior.</li>
        <li>Use the TXT build steps to recreate the circuit in any simulator.</li>
      </ol>
    </div>
  `;

  document.querySelectorAll("[data-artifact]").forEach((link) => {
    link.addEventListener("click", () => {
      const type = link.dataset.artifact;
      setStatus(`Starting ${type.toUpperCase()} download...`);
      renderManualDownload(type, links.find((item) => item.type === type));
      window.setTimeout(() => setStatus(""), 1800);
    });
  });
}

function buildDownloadLinks(data) {
  const serverArtifacts = data.artifacts || {};
  const isSequential = data.parsed?.type === "sequential";
  const items = [
    !isSequential && artifactDefinition("cv", "Download Experimental .cv File", "ai-generated-circuit.cv", "application/octet-stream", data.simulatorCircuit ? JSON.stringify(data.simulatorCircuit, null, 2) : JSON.stringify(data.circuitModel, null, 2), serverArtifacts.cv),
    artifactDefinition("svg", "Download SVG", "ai-generated-circuit.svg", "image/svg+xml", data.diagramSvg, serverArtifacts.svg),
    artifactDefinition("csv", "Download CSV", "truth-table.csv", "text/csv", toCsv(data.truthTable), serverArtifacts.csv),
    artifactDefinition("txt", "Download TXT", "logic-build-steps.txt", "text/plain", data.instructions.join("\n"), serverArtifacts.txt),
    artifactDefinition("json", "Download JSON", "internal-circuit-model.json", "application/json", JSON.stringify(data.circuitModel, null, 2), serverArtifacts.json)
  ].filter(Boolean);
  return items.map((item) => {
    if (item.server?.downloadUrl) {
      return {
        ...item,
        url: `${API_BASE}${item.server.downloadUrl}`,
        filename: item.server.filename || item.filename,
        content: item.server.content || item.content
      };
    }
    return makeDownload(item);
  });
}

function artifactDefinition(type, label, filename, mimeType, content, server) {
  return { type, label, filename, mimeType, content, server };
}

function makeDownload(item) {
  const blob = new Blob([item.content], { type: item.mimeType });
  const url = URL.createObjectURL(blob);
  state.downloadUrls.push(url);
  return { ...item, url };
}

function renderManualDownload(type, item) {
  const panel = document.querySelector("#manualDownload");
  if (!panel || !item) return;
  const maxPreview = type === "cv" || type === "json" ? 12000 : 6000;
  panel.hidden = false;
  panel.innerHTML = `
    <h3>Download fallback</h3>
    <p>If the browser does not save the file automatically, open this link or use the content below.</p>
    <p><a class="download-button" href="${item.url}" download="${item.filename}" target="_blank">Open ${escapeHtml(item.filename)}</a></p>
    <textarea readonly>${escapeHtml(String(item.content || "").slice(0, maxPreview))}</textarea>
  `;
}

function clearDownloadUrls() {
  state.downloadUrls.forEach((url) => URL.revokeObjectURL(url));
  state.downloadUrls = [];
}

function toCsv(rows) {
  if (!rows || !rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escapeCsv = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(","))].join("\n");
}

function activateTab(tab) {
  document.querySelectorAll(".tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tab);
  });
  if (tab === "simulator" && state.analysis) {
    loadSimulator(state.analysis);
  }
}

function setStatus(message, isError = false) {
  statusBox.hidden = !message;
  statusBox.textContent = message;
  statusBox.classList.toggle("error", isError);
}

/** Returns a human-readable initial state hint for sequential circuits. */
function buildInitialStateHint(parsed) {
  const stateVars = parsed.stateVariables || [];
  if (!stateVars.length) {
    return "Reset all flip-flop outputs to 0 before stepping through the state sequence.";
  }
  const zeroState = stateVars.map((v) => `${v}=0`).join(", ");
  return `Typical reset/start state: ${zeroState}. Apply clock pulses and observe Q outputs transition through the state sequence shown in the truth table.`;
}

function dlIcon(type) {
  const icons = { cv: "🔌", svg: "🖼", csv: "📊", txt: "📋", json: "🗂" };
  return icons[type] || "📄";
}

/**
 * Render the AI cross-check details (disputed rows or skip reason)
 * as a small inline block to append to the main verify badge.
 */
function buildAiCrossCheckBlock(ai) {
  if (!ai) return "";
  if (ai.skipped) {
    return `<div class="ai-check-note">AI cross-check skipped &mdash; ${escapeHtml(ai.reason || "n/a")}.</div>`;
  }
  if (!ai.compared) return "";
  if (ai.match) return "";

  const rows = (ai.mismatches || []).map((m) => {
    const inputs = Object.entries(m.inputs || {})
      .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
      .join(", ");
    return `<li>row ${escapeHtml(String(m.rowIndex))} (${inputs}): output <code>${escapeHtml(m.output)}</code> &mdash; local says <strong>${escapeHtml(String(m.ours))}</strong>, AI expected <strong>${escapeHtml(String(m.ai))}</strong></li>`;
  }).join("");

  const more = ai.mismatchCount > (ai.mismatches?.length || 0)
    ? `<li>… and ${escapeHtml(String(ai.mismatchCount - ai.mismatches.length))} more</li>`
    : "";

  return `<div class="ai-check-note"><strong>Disputed rows:</strong><ul class="ai-check-list">${rows}${more}</ul></div>`;
}

/**
 * Render the model-graph simulation result. The graph is built from the same
 * expressions the truth table uses, so a divergence here means a wiring/model
 * bug — distinct from an AI logic error.
 */
function buildGraphCheckBlock(graph) {
  if (!graph) return "";
  if (graph.skipped) return "";
  if (graph.verified) return "";
  const rows = (graph.issues || []).map((i) => {
    const inputs = Object.entries(i.inputs || {})
      .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
      .join(", ");
    return `<li>row (${inputs}): output <code>${escapeHtml(i.output)}</code> &mdash; expressions say <strong>${escapeHtml(String(i.expected))}</strong>, gate graph simulated <strong>${escapeHtml(String(i.simulated))}</strong> (driven by <code>${escapeHtml(i.drivenBy || "?")}</code>)</li>`;
  }).join("");
  const more = graph.issueCount > (graph.issues?.length || 0)
    ? `<li>… and ${escapeHtml(String(graph.issueCount - graph.issues.length))} more</li>`
    : "";
  return `<div class="ai-check-note"><strong>Diagram simulation diverged from expressions:</strong><ul class="ai-check-list">${rows}${more}</ul></div>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
