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
  renderTruthTable(data.truthTable, data.verification, data.parsed?.outputs);
  document.querySelector("#steps").innerHTML = `<ol>${data.instructions.map((step) => `<li>${escapeHtml(step.replace(/^Step \d+:\s*/, ""))}</li>`).join("")}</ol>`;
  renderDownloads(data);
  renderSimulatorPanel(data);
  // If the simulator frame is already loaded (user visited the tab earlier), update it immediately.
  if (data.parsed?.type !== "sequential" && state.simulatorFrameLoaded) loadSimulator(data);
  activateTab("summary");
  recolorAllDiagrams();
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
    sendThemeToSimulator();
  };

  const sendWithRetries = () => {
    state.simulatorLoadListener = null;
    state.simulatorFrameLoaded = true;
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
      <!-- Panel toggle -->
      <button type="button" id="simPanelBtn" class="sim-btn-active" title="Show/hide gate palette (P)">&#x229E; Panel</button>
      <span class="sim-sep"></span>
      <!-- Edit -->
      <button type="button" id="simUndoBtn"   title="Undo (Ctrl+Z)">&#x21A9; Undo</button>
      <button type="button" id="simRedoBtn"   title="Redo (Ctrl+Y)">&#x21AA; Redo</button>
      <button type="button" id="simDeleteBtn" title="Delete selected element (Del)">&#x2715; Delete</button>
      <span class="sim-sep"></span>
      <!-- View -->
      <button type="button" id="simFitBtn"      title="Fit circuit to screen (F)">&#x26F6; Fit</button>
      <button type="button" id="simZoomInBtn"   title="Zoom in (+)">&#x2b; Zoom</button>
      <button type="button" id="simZoomOutBtn"  title="Zoom out (−)">&#x2212; Zoom</button>
      <span class="sim-sep"></span>
      <!-- Save / New / Clear -->
      <button type="button" id="simSaveBtn"  title="Download circuit as .cv file">&#x1F4BE; Save</button>
      <button type="button" id="simNewBtn"   title="Add a new blank circuit tab">&#x2795; New</button>
      <button type="button" id="simClearBtn" class="sim-btn-danger" title="Clear canvas and start fresh">&#x1F5D1; Clear</button>
      <span class="sim-hint-label">Drag gates from panel &nbsp;·&nbsp; Click pins to wire &nbsp;·&nbsp; Scroll to zoom &nbsp;·&nbsp; Del to remove</span>
    </div>
    <iframe id="cvSimulator" src="about:blank" title="CircuitVerse Simulator" allowfullscreen></iframe>`;

  // Send a command into the simulator iframe
  const simCmd = (type) => {
    const fr = document.querySelector("#cvSimulator");
    if (fr && fr.contentWindow) fr.contentWindow.postMessage({ type }, "*");
  };

  // Track panel-open state so the outer button reflects inner toggle
  let simPanelOpen = true;
  document.querySelector("#simPanelBtn").addEventListener("click", () => {
    simCmd("simTogglePanel");
    simPanelOpen = !simPanelOpen;
    document.querySelector("#simPanelBtn").classList.toggle("sim-btn-active", simPanelOpen);
  });
  document.querySelector("#simUndoBtn").addEventListener("click",   () => simCmd("simUndo"));
  document.querySelector("#simRedoBtn").addEventListener("click",   () => simCmd("simRedo"));
  document.querySelector("#simDeleteBtn").addEventListener("click", () => simCmd("simDelete"));
  document.querySelector("#simFitBtn").addEventListener("click",    () => simCmd("simFit"));
  document.querySelector("#simZoomInBtn").addEventListener("click", () => simCmd("simZoomIn"));
  document.querySelector("#simZoomOutBtn").addEventListener("click",() => simCmd("simZoomOut"));
  document.querySelector("#simSaveBtn").addEventListener("click",   () => simCmd("simSave"));
  document.querySelector("#simNewBtn").addEventListener("click",    () => simCmd("simNewCircuit"));
  document.querySelector("#simClearBtn").addEventListener("click",  () => {
    if (window.confirm("Clear the simulator canvas and start a fresh circuit?")) {
      simCmd("simClear");
    }
  });
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

function renderTruthTable(rows, verification, outputNames) {
  const badge = buildVerifyBadge(verification);
  if (!rows.length) {
    document.querySelector("#truth").innerHTML = `${badge}<p>No rows generated.</p>`;
    return;
  }
  const headers = Object.keys(rows[0]);
  // Build a Set of output column names. Falls back to only the last column
  // when no parsed output list is passed (keeps backward-compatibility).
  const outputSet = outputNames && outputNames.length
    ? new Set(outputNames)
    : new Set(headers.length > 1 ? [headers[headers.length - 1]] : headers);
  document.querySelector("#truth").innerHTML = `
    ${badge}
    <div class="table-wrap">
      <table>
        <thead><tr>${headers.map((h) => `<th${outputSet.has(h) ? ' class="col-output"' : ""}>${escapeHtml(h)}</th>`).join("")}</tr></thead>
        <tbody>
          ${rows.map((row) => `<tr>${headers.map((h) => {
            const val = String(row[h] ?? "");
            const isOut = outputSet.has(h);
            return `<td${isOut ? ` class="col-output" data-output="${escapeHtml(val)}"` : ""}>${escapeHtml(val)}</td>`;
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
  // Always generate client-side blob URLs from the inline response content.
  // Server-side bundle download IDs (/api/download/:id/:type) use an in-memory Map
  // that is not shared across serverless instances (Vercel/Railway), so those URLs
  // frequently 404. Blob URLs are instant, work offline, and never expire.
  return items.map((item) => makeDownload(item));
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

// ── Simulator iframe theme relay ─────────────────────────────────────────────
/** Send the current theme to the simulator iframe so it can match. */
function sendThemeToSimulator() {
  const theme = document.documentElement.getAttribute("data-theme") || "light";
  const iframe = document.querySelector("#cvSimulator");
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type: "setTheme", theme }, "*");
  }
}

// ── SVG diagram theme recoloring ──────────────────────────────────────────────
// Remaps the server-generated SVG (dark neon palette) to a light Zeus palette
// when the light theme is active, and restores originals for dark mode.
function applySvgTheme(svgEl, theme) {
  if (!svgEl) return;
  const isLight = (theme !== "dark");

  svgEl.querySelectorAll("*").forEach((el) => {
    const tag = el.tagName.toLowerCase();

    // Snapshot original attribute values on first visit (idempotent)
    ["fill", "stroke"].forEach((attr) => {
      if (el.hasAttribute(attr) && !el.hasAttribute("data-orig-" + attr)) {
        el.setAttribute("data-orig-" + attr, el.getAttribute(attr));
      }
    });

    const oFill   = el.getAttribute("data-orig-fill")   || "";
    const oStroke = el.getAttribute("data-orig-stroke") || "";
    const sw      = el.getAttribute("stroke-width")     || "";

    // Restore dark originals when switching back
    if (!isLight) {
      if (oFill)   el.setAttribute("fill",   oFill);
      if (oStroke) el.setAttribute("stroke", oStroke);
      return;
    }

    // ── Light / Zeus palette ───────────────────────────────────────────────

    // Main background rect (width="100%")
    if (tag === "rect" && oFill === "#0a0a0a" && el.getAttribute("width") === "100%") {
      el.setAttribute("fill", "#f5f8ff");

    // Header tint band
    } else if (tag === "rect" && oFill.includes("rgba(240,98,138")) {
      el.setAttribute("fill", "rgba(59,130,246,0.04)");

    // Header divider line (rgba stroke)
    } else if (tag === "line" && oStroke.includes("rgba(240,98,138")) {
      el.setAttribute("stroke", "rgba(59,130,246,0.15)");

    // Gate body paths — dark burgundy fill + pink stroke → ivory + amber
    } else if (tag === "path" && oFill === "#1e0710") {
      el.setAttribute("fill",   "#fff8ed");
      el.setAttribute("stroke", "#d97706");

    // Inversion bubbles (NOT/NAND/NOR/XNOR) — black fill + pink stroke
    } else if (tag === "circle" && oFill === "#0a0a0a") {
      el.setAttribute("fill",   "#f5f8ff");
      el.setAttribute("stroke", "#d97706");

    // Junction dots — pink fill → sky blue
    } else if (tag === "circle" && oFill === "#f0628a") {
      el.setAttribute("fill", "#2563eb");

    // Wire paths — fill:none, stroke-width 1.8 → sky blue
    } else if (tag === "path" && oFill === "none" && sw === "1.8") {
      el.setAttribute("stroke", "#2563eb");

    // XOR / XNOR back-curve — fill:none, stroke-width 1.5 → amber
    } else if (tag === "path" && oFill === "none" && sw === "1.5") {
      el.setAttribute("stroke", "#d97706");

    // Input tick lines → sky blue
    } else if (tag === "line" && oStroke === "#f0628a") {
      el.setAttribute("stroke", "#2563eb");

    // INPUT pin shape → light green
    } else if (tag === "path" && oFill === "#0d1f14") {
      el.setAttribute("fill",   "#f0fdf4");
      el.setAttribute("stroke", "#16a34a");

    // OUTPUT pin shape → light cyan
    } else if (tag === "path" && oFill === "#0d1825") {
      el.setAttribute("fill",   "#ecfeff");
      el.setAttribute("stroke", "#0891b2");

    // CONST pin rect
    } else if (tag === "rect" && oFill === "#141414") {
      el.setAttribute("fill",   "#f8fafc");
      el.setAttribute("stroke", "#94a3b8");

    // Text: title + gate-type labels (primary pink → dark amber)
    } else if (tag === "text" && oFill === "#f0628a") {
      el.setAttribute("fill", "#92400e");

    // Text: subtitle
    } else if (tag === "text" && oFill === "#606070") {
      el.setAttribute("fill", "#64748b");

    // Text: gate sub-labels below body
    } else if (tag === "text" && oFill === "#808080") {
      el.setAttribute("fill", "#94a3b8");

    // Text: DFF port labels (lighter pink)
    } else if (tag === "text" && oFill === "#ff8cad") {
      el.setAttribute("fill", "#92400e");

    // Text: INPUT pin label (mint green)
    } else if (tag === "text" && oFill === "#6ee7b7") {
      el.setAttribute("fill", "#14532d");

    // Text: OUTPUT pin label (light cyan)
    } else if (tag === "text" && oFill === "#67e8f9") {
      el.setAttribute("fill", "#164e63");

    // Text: CONST pin label (#aaa)
    } else if (tag === "text" && (oFill === "#aaa" || oFill === "#aaaaaa")) {
      el.setAttribute("fill", "#475569");
    }
  });
}

/** Recolor every .svg-wrap svg on the page to match the current theme. */
function recolorAllDiagrams() {
  const theme = document.documentElement.getAttribute("data-theme") || "light";
  document.querySelectorAll(".svg-wrap svg").forEach((svg) => applySvgTheme(svg, theme));
}

// ── Theme toggle ──────────────────────────────────────────────────────────────
(function themeInit() {
  const root = document.documentElement;
  const btn  = document.getElementById("themeToggle");
  const icon = btn ? btn.querySelector(".theme-icon") : null;

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
    if (icon) icon.textContent = theme === "dark" ? "☀️" : "🌙";
    // Recolor any diagrams already on screen
    recolorAllDiagrams();
    // Push theme into the simulator iframe so it matches
    sendThemeToSimulator();
  }

  // Load saved preference; default to light
  applyTheme(localStorage.getItem("theme") || "light");

  if (btn) {
    btn.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      // Spin animation
      btn.style.transition = "transform 0.38s cubic-bezier(0.2,0.8,0.3,1), box-shadow 0.25s, background 0.4s, border-color 0.4s";
      btn.style.transform  = "rotate(360deg) scale(1.2)";
      setTimeout(() => { btn.style.transform = ""; }, 380);
      applyTheme(next);
    });
  }
})();

// ── Electric arc / lightning bolt effects ─────────────────────────────────────
// Randomly spawns neon lightning bolts with multi-return-stroke flicker,
// branching channels, dual-layer glow, and a lingering corona bloom.
// Fires every 3–9 s; 35 % chance of rapid double-strike.
(function electricArcs() {
  const NS = "http://www.w3.org/2000/svg";

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function rndInt(a, b) { return Math.floor(rnd(a, b + 1)); }
  function pick(...arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // Palettes switch with the active theme
  const LIGHT_PALETTES = [
    { color: "#ffd60a", aura: "rgba(255,214,10,0.55)",  halo: "rgba(255,200,0,0.32)"   }, // zeus gold
    { color: "#ffd60a", aura: "rgba(255,214,10,0.55)",  halo: "rgba(255,200,0,0.32)"   }, // zeus gold ×2
    { color: "#ffffff", aura: "rgba(255,255,255,0.55)",  halo: "rgba(200,220,255,0.3)"  }, // divine white
    { color: "#a855f7", aura: "rgba(168,85,247,0.48)",  halo: "rgba(168,85,247,0.26)"  }, // olympian violet
  ];
  const DARK_PALETTES = [
    { color: "#1a6fff", aura: "rgba(26,111,255,0.5)",   halo: "rgba(26,111,255,0.28)"  }, // electric blue
    { color: "#1a6fff", aura: "rgba(26,111,255,0.5)",   halo: "rgba(26,111,255,0.28)"  }, // electric blue ×2
    { color: "#00e5ff", aura: "rgba(0,229,255,0.45)",   halo: "rgba(0,229,255,0.25)"   }, // electric cyan
    { color: "#ff2d78", aura: "rgba(255,45,120,0.45)",  halo: "rgba(255,45,120,0.22)"  }, // neon pink
  ];
  function activePalettes() {
    return document.documentElement.getAttribute("data-theme") === "dark"
      ? DARK_PALETTES : LIGHT_PALETTES;
  }

  /**
   * Build jagged polyline points for a lightning channel.
   * jitter controls how wild the zig-zag is (0–1 scale factor).
   */
  function buildChannelPts(length, segments, jitter) {
    const segH = length / segments;
    const j    = jitter !== undefined ? jitter : 0.85;
    const pts  = [[0, 0]];
    for (let i = 1; i < segments; i++) {
      pts.push([rnd(-segH * j, segH * j), segH * i]);
    }
    pts.push([rnd(-segH * 0.3, segH * 0.3), length]);
    return pts;
  }

  /** Add glow filter(s) to <defs>. Returns [outerFid, innerFid]. */
  function addGlowFilters(defs) {
    const ts = Date.now() + Math.random().toString(36).slice(2);

    function makeFilter(id, stdDev) {
      const f = document.createElementNS(NS, "filter");
      f.setAttribute("id", id);
      f.setAttribute("x", "-400%"); f.setAttribute("y", "-400%");
      f.setAttribute("width", "900%"); f.setAttribute("height", "900%");
      const b = document.createElementNS(NS, "feGaussianBlur");
      b.setAttribute("in", "SourceGraphic");
      b.setAttribute("stdDeviation", stdDev);
      f.appendChild(b);
      defs.appendChild(f);
    }

    const outerFid = "ef-o" + ts;
    const innerFid = "ef-i" + ts;
    makeFilter(outerFid, "7");    // wide atmospheric aura
    makeFilter(innerFid, "2.5"); // tight inner halo
    return [outerFid, innerFid];
  }

  /** Append polyline layers for one channel onto the SVG. */
  function addChannel(svg, pts, pal, outerFid, innerFid, opts) {
    const ptStr      = pts.map(p => p.join(",")).join(" ");
    const outerW     = opts.outerW  || 10;
    const haloW      = opts.haloW   || 3.5;
    const strokeW    = opts.strokeW || 1.8;
    const coreW      = opts.coreW   || rnd(0.35, 0.75).toFixed(2);
    const dimOpacity = opts.dim     || 1;

    // Outer atmospheric aura
    const outer = document.createElementNS(NS, "polyline");
    outer.setAttribute("points", ptStr);
    outer.setAttribute("fill", "none");
    outer.setAttribute("stroke", pal.aura);
    outer.setAttribute("stroke-width", outerW);
    outer.setAttribute("filter", `url(#${outerFid})`);
    outer.setAttribute("stroke-linecap", "round");
    outer.setAttribute("opacity", dimOpacity);
    svg.appendChild(outer);

    // Inner tight halo
    const halo = document.createElementNS(NS, "polyline");
    halo.setAttribute("points", ptStr);
    halo.setAttribute("fill", "none");
    halo.setAttribute("stroke", pal.halo);
    halo.setAttribute("stroke-width", haloW);
    halo.setAttribute("filter", `url(#${innerFid})`);
    halo.setAttribute("stroke-linecap", "round");
    halo.setAttribute("opacity", dimOpacity);
    svg.appendChild(halo);

    // Bright main stroke
    const line = document.createElementNS(NS, "polyline");
    line.setAttribute("points", ptStr);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", pal.color);
    line.setAttribute("stroke-width", strokeW);
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("opacity", dimOpacity);
    svg.appendChild(line);

    // White-hot core
    const core = document.createElementNS(NS, "polyline");
    core.setAttribute("points", ptStr);
    core.setAttribute("fill", "none");
    core.setAttribute("stroke", "#ffffff");
    core.setAttribute("stroke-width", coreW);
    core.setAttribute("opacity", (0.8 * dimOpacity).toFixed(2));
    core.setAttribute("stroke-linecap", "round");
    svg.appendChild(core);
  }

  /** Spawn one lightning bolt (main channel + optional branches) */
  function spawnBolt() {
    const pal      = pick(...activePalettes());
    const length   = rnd(100, 320);
    const segments = rndInt(6, 13);
    const angle    = rnd(-65, 65);
    const vx       = rnd(4, 93);   // viewport %
    const vy       = rnd(3, 68);

    const pts  = buildChannelPts(length, segments);
    const xs   = pts.map(p => p[0]);
    const minX = Math.min(...xs) - 16;
    const maxX = Math.max(...xs) + 16;
    const w    = maxX - minX;
    const h    = length + 28;

    // SVG container
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width",   w);
    svg.setAttribute("height",  h);
    svg.setAttribute("viewBox", `${minX} -14 ${w} ${h}`);
    svg.style.cssText = [
      "position:fixed",
      `left:${vx}vw`, `top:${vy}vh`,
      `transform:rotate(${angle}deg)`,
      "transform-origin:top center",
      "pointer-events:none", "z-index:0", "overflow:visible",
      "opacity:0",
      "animation:e-bolt-strike 0.85s cubic-bezier(0.08,0.9,0.3,1) forwards"
    ].join(";");

    const defs = document.createElementNS(NS, "defs");
    svg.appendChild(defs);
    const [outerFid, innerFid] = addGlowFilters(defs);

    // Main channel — outer stroke proportional to length
    const outerW = Math.max(9, length * 0.04);
    addChannel(svg, pts, pal, outerFid, innerFid, { outerW, haloW: 3.5, strokeW: 1.9 });

    // Branch channels — 45 % chance, 1–2 branches
    if (Math.random() < 0.45) {
      const numBranches = Math.random() < 0.45 ? 2 : 1;
      for (let b = 0; b < numBranches; b++) {
        const fromIdx   = rndInt(Math.floor(segments * 0.25), Math.floor(segments * 0.65));
        const origin    = pts[fromIdx];
        const bLen      = rnd(28, length * 0.48);
        const bSegs     = rndInt(3, 6);
        const rawBranch = buildChannelPts(bLen, bSegs, 1.05);
        // Offset branch points from the fork point
        const branchPts = rawBranch.map(p => [p[0] + origin[0], p[1] + origin[1]]);
        addChannel(svg, branchPts, pal, outerFid, innerFid, {
          outerW: Math.max(5, outerW * 0.5),
          haloW: 2,
          strokeW: 1.1,
          dim: 0.65
        });
      }
    }

    document.body.appendChild(svg);

    // Radial flash at strike origin
    const flash = document.createElement("div");
    flash.className = "e-flash";
    flash.style.setProperty("--fx", vx + "vw");
    flash.style.setProperty("--fy", vy + "vh");
    document.body.appendChild(flash);

    // Slow-fading corona bloom
    const corona = document.createElement("div");
    corona.className = "e-corona";
    corona.style.setProperty("--fx", vx + "vw");
    corona.style.setProperty("--fy", vy + "vh");
    document.body.appendChild(corona);

    setTimeout(() => { svg.remove(); flash.remove(); corona.remove(); }, 1600);
  }

  /** Schedule next strike; 35 % chance of rapid double-tap */
  function schedule() {
    setTimeout(() => {
      spawnBolt();
      if (Math.random() < 0.35) setTimeout(spawnBolt, rnd(60, 180));
      schedule();
    }, rnd(3000, 9000));
  }

  setTimeout(schedule, rnd(1200, 3500));
})();
