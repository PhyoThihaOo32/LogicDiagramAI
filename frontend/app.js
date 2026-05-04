const state = {
  analysis: null,
  downloadUrls: [],
  simulatorRetryTimers: [],
  simulatorFrameLoaded: false,
  simulatorLoadListener: null
};
// When served from the Express backend (port 3000) use relative URLs.
// When opened via file:// or a dev server (e.g. Live Server on 5500), point at the backend directly.
// Use 127.0.0.1 because the backend intentionally binds there; localhost can
// resolve to ::1 on some machines and fail even while the server is running.
const API_BASE =
  window.location.protocol === "file:" || window.location.port !== "3000"
    ? "http://127.0.0.1:3000"
    : "";

const question = document.querySelector("#question");
const imageInput = document.querySelector("#imageInput");
const imageName = document.querySelector("#imageName");
const analyzeBtn = document.querySelector("#analyzeBtn");
const statusBox = document.querySelector("#status");
const results = document.querySelector("#results");
const simulatorFrame = document.querySelector("#cvSimulator");

if (simulatorFrame) {
  simulatorFrame.addEventListener("load", () => {
    state.simulatorFrameLoaded = simulatorFrame.src !== "about:blank";
  });
}

document.querySelectorAll("[data-sample]").forEach((button) => {
  button.addEventListener("click", () => {
    question.value = button.dataset.sample;
  });
});

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab));
});

analyzeBtn.addEventListener("click", analyze);
imageInput.addEventListener("change", () => {
  imageName.textContent = imageInput.files[0] ? imageInput.files[0].name : "No image selected";
});

if (window.location.protocol === "file:") {
  setStatus("Running from a local file. The app will use the backend at http://127.0.0.1:3000; for the most reliable experience, open that URL directly.");
}

async function analyze(event) {
  if (event) event.preventDefault();
  setStatus(imageInput.files[0] ? "Reading image and generating circuit..." : "Generating circuit...");
  analyzeBtn.disabled = true;
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
    }
    renderResults(data);
    setStatus("");
    results.hidden = false;
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    analyzeBtn.disabled = false;
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
  renderTruthTable(data.truthTable);
  document.querySelector("#preview").innerHTML = `<div class="svg-wrap">${data.diagramSvg}</div>`;
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
          <p>${escapeHtml(data.parsed.stateDiagram || "Use the D equations and truth table to step the state bits on each clock.")}</p>
        </div>
        <div class="card">
          <h3>Initial State</h3>
          <p>For a simple traffic light, reset/start with Q1Q0 = 00. That makes Green = 1, Yellow = 0, and Red = 0.</p>
        </div>
      </div>
      <div class="svg-wrap">${data.diagramSvg}</div>
      </div>
    `;
    return;
  }

  panel.innerHTML = `<iframe id="cvSimulator" src="about:blank" title="CircuitVerse Simulator" allowfullscreen></iframe>`;
}

function renderSummary(data) {
  const parsed = data.parsed;
  const stateVariables = parsed.stateVariables || [];
  const externalInputs = data.circuitModel?.inputs || parsed.inputs || [];
  const visibleOutputs = (data.circuitModel?.gates || [])
    .filter((gate) => gate.type === "OUTPUT")
    .map((gate) => gate.label);
  document.querySelector("#summary").innerHTML = `
    <div class="grid">
      <div class="card"><h3>Type</h3><p>${escapeHtml(parsed.type)}${parsed.subtype ? ` / ${escapeHtml(parsed.subtype)}` : ""}</p></div>
      <div class="card"><h3>External Inputs</h3><p>${escapeHtml(externalInputs.join(", ") || "none")}</p></div>
      <div class="card"><h3>${parsed.type === "sequential" ? "State / Equations" : "Outputs"}</h3><p>${escapeHtml(parsed.outputs.join(", "))}</p></div>
      ${stateVariables.length ? `<div class="card"><h3>State Variables</h3><p>${escapeHtml(stateVariables.join(", "))}</p></div>` : ""}
      ${visibleOutputs.length && parsed.type === "sequential" ? `<div class="card"><h3>Visible Outputs</h3><p>${escapeHtml(visibleOutputs.join(", "))}</p></div>` : ""}
    </div>
    <h3>Expressions</h3>
    <pre>${escapeHtml(JSON.stringify(parsed.expressions, null, 2))}</pre>
    ${data.imageExtraction ? `<h3>Image Extraction</h3><pre>${escapeHtml(JSON.stringify(data.imageExtraction, null, 2))}</pre>` : ""}
    <h3>Circuit Diagram</h3>
    <div class="svg-wrap">${data.diagramSvg}</div>
    ${parsed.stateDiagram ? `<h3>State Diagram</h3><pre>${escapeHtml(parsed.stateDiagram)}</pre>` : ""}
  `;
}

function renderTruthTable(rows) {
  if (!rows.length) {
    document.querySelector("#truth").innerHTML = "<p>No rows generated.</p>";
    return;
  }
  const headers = Object.keys(rows[0]);
  document.querySelector("#truth").innerHTML = `
    <table>
      <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.map((row) => `<tr>${headers.map((header) => `<td>${escapeHtml(row[header])}</td>`).join("")}</tr>`).join("")}
      </tbody>
    </table>
  `;
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
      ${links.map((link) => `<a class="download-button" href="${link.url}" download="${link.filename}" target="_blank" data-artifact="${link.type}">${link.label}</a>`).join("")}
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
