const state = {
  xml1: null,
  xml2: null,
  insertionTime: 0,
  mergedText: "",
  mergedSegments: [],
};

const elements = {
  dropZones: document.querySelectorAll(".drop-zone"),
  xml1Input: document.getElementById("xml1-input"),
  xml2Input: document.getElementById("xml2-input"),
  xml1Meta: document.getElementById("xml1-meta"),
  xml2Meta: document.getElementById("xml2-meta"),
  insertionSlider: document.getElementById("insertion-slider"),
  insertionTime: document.getElementById("insertion-time"),
  applyTime: document.getElementById("apply-time"),
  timelineSummary: document.getElementById("timeline-summary"),
  mergeButton: document.getElementById("merge-button"),
  exportButton: document.getElementById("export-button"),
  previewWindow: document.getElementById("preview-window"),
  status: document.getElementById("status"),
};

setup();

function setup() {
  setupDropZones();
  elements.xml1Input.addEventListener("change", (event) => handleInputChange(event, "xml1"));
  elements.xml2Input.addEventListener("change", (event) => handleInputChange(event, "xml2"));
  elements.insertionSlider.addEventListener("input", onSliderChange);
  elements.applyTime.addEventListener("click", onApplyTime);
  elements.mergeButton.addEventListener("click", generateMergePreview);
  elements.exportButton.addEventListener("click", exportMergedXml);
  setStatus("Upload both XML files to begin.", false);
}

function setupDropZones() {
  elements.dropZones.forEach((zone) => {
    const target = zone.dataset.target;
    zone.addEventListener("click", () => {
      if (target === "xml1") {
        elements.xml1Input.click();
      } else {
        elements.xml2Input.click();
      }
    });

    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("dragover");
    });

    zone.addEventListener("dragleave", () => {
      zone.classList.remove("dragover");
    });

    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("dragover");
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) {
        return;
      }
      loadFile(files[0], target).catch((error) => {
        setStatus(error.message, true);
      });
    });
  });
}

async function handleInputChange(event, target) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }
  try {
    await loadFile(file, target);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    event.target.value = "";
  }
}

async function loadFile(file, target) {
  if (!isXmlFile(file)) {
    throw new Error(`"${file.name}" is not an XML file.`);
  }
  const rawText = await file.text();
  const parsed = parseXmlFile(rawText, file.name);
  state[target] = parsed;
  updateFileMeta(target, parsed);
  markDropZoneLoaded(target);
  resetPreview();
  updateControls();
  setStatus(`${target.toUpperCase()} loaded: ${file.name}`, false);
}

function isXmlFile(file) {
  const lower = file.name.toLowerCase();
  return lower.endsWith(".xml") || file.type.includes("xml");
}

function parseXmlFile(xmlText, fileName) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    throw new Error(`"${fileName}" contains invalid XML and could not be parsed.`);
  }

  const root = doc.documentElement;
  if (!root) {
    throw new Error(`"${fileName}" has no XML root element.`);
  }

  const points = extractTimedPoints(root);
  if (points.length === 0) {
    throw new Error(
      `"${fileName}" does not contain timed elements. Include attributes like time/start/timestamp.`
    );
  }

  points.sort((a, b) => a.time - b.time);
  const duration = points[points.length - 1].time;
  const lineCount = xmlText.split(/\r?\n/).length;

  return {
    fileName,
    xmlText,
    rootName: root.tagName,
    points,
    duration,
    lineCount,
  };
}

function extractTimedPoints(root) {
  const nodes = Array.from(root.querySelectorAll("*"));
  const points = [];
  nodes.forEach((node) => {
    const time = getTimeFromElement(node);
    if (time === null) {
      return;
    }
    points.push({
      time,
      nodeName: node.tagName,
      xml: new XMLSerializer().serializeToString(node),
    });
  });
  return points;
}

function getTimeFromElement(node) {
  const attrs = ["time", "start", "timestamp", "t", "begin"];
  for (const attr of attrs) {
    const val = node.getAttribute(attr);
    if (val === null) {
      continue;
    }
    const parsed = parseFlexibleTime(val);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function parseFlexibleTime(input) {
  if (typeof input !== "string") {
    return null;
  }
  const value = input.trim();
  if (!value) {
    return null;
  }

  // Numeric seconds, for example: 12.5
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return null;
    }
    return Math.max(0, number);
  }

  // HH:MM:SS(.mmm) or MM:SS(.mmm)
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  const numeric = parts.map((part) => Number(part));
  if (numeric.some((n) => !Number.isFinite(n))) {
    return null;
  }
  let seconds = 0;
  if (parts.length === 3) {
    seconds = numeric[0] * 3600 + numeric[1] * 60 + numeric[2];
  } else {
    seconds = numeric[0] * 60 + numeric[1];
  }
  return Math.max(0, seconds);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00:00.000";
  }
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const wholeSecs = Math.floor(secs);
  const millis = Math.round((secs - wholeSecs) * 1000);
  const normalizedMillis = String(millis).padStart(3, "0");
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    wholeSecs
  ).padStart(2, "0")}.${normalizedMillis}`;
}

function updateFileMeta(target, parsed) {
  const metaElement = target === "xml1" ? elements.xml1Meta : elements.xml2Meta;
  metaElement.textContent = `${parsed.fileName} | Root: <${parsed.rootName}> | Timed nodes: ${
    parsed.points.length
  } | Duration: ${formatTime(parsed.duration)}`;
}

function markDropZoneLoaded(target) {
  elements.dropZones.forEach((zone) => {
    if (zone.dataset.target === target) {
      zone.classList.add("loaded");
    }
  });
}

function resetPreview() {
  state.mergedText = "";
  state.mergedSegments = [];
  elements.exportButton.disabled = true;
  elements.previewWindow.innerHTML =
    '<div class="placeholder">Merged XML preview will appear here.</div>';
}

function updateControls() {
  const ready = Boolean(state.xml1 && state.xml2);
  elements.insertionSlider.disabled = !ready;
  elements.insertionTime.disabled = !ready;
  elements.applyTime.disabled = !ready;
  elements.mergeButton.disabled = !ready;

  if (!ready) {
    elements.timelineSummary.textContent = "Upload both XML files to enable timeline alignment.";
    return;
  }

  const duration1 = Math.max(0, state.xml1.duration);
  elements.insertionSlider.max = String(duration1);
  elements.insertionSlider.step = duration1 >= 1000 ? "1" : "0.001";
  elements.insertionSlider.value = String(Math.min(state.insertionTime, duration1));
  state.insertionTime = Number(elements.insertionSlider.value);
  elements.insertionTime.value = formatTime(state.insertionTime);
  renderTimelineSummary();
}

function onSliderChange() {
  state.insertionTime = Number(elements.insertionSlider.value);
  elements.insertionTime.value = formatTime(state.insertionTime);
  renderTimelineSummary();
}

function onApplyTime() {
  const parsed = parseFlexibleTime(elements.insertionTime.value);
  if (parsed === null) {
    setStatus("Invalid insertion time. Use HH:MM:SS.mmm or numeric seconds.", true);
    return;
  }

  if (!state.xml1) {
    return;
  }

  const clamped = Math.max(0, Math.min(parsed, state.xml1.duration));
  state.insertionTime = clamped;
  elements.insertionSlider.value = String(clamped);
  elements.insertionTime.value = formatTime(clamped);
  renderTimelineSummary();
  setStatus(`Insertion time updated to ${formatTime(clamped)}.`, false);
}

function renderTimelineSummary() {
  if (!state.xml1 || !state.xml2) {
    return;
  }
  elements.timelineSummary.textContent = `XML File 1 duration: ${formatTime(
    state.xml1.duration
  )}. XML File 2 duration: ${formatTime(state.xml2.duration)}. XML File 2 will start at ${formatTime(
    state.insertionTime
  )} in XML File 1.`;
}

function generateMergePreview() {
  if (!state.xml1 || !state.xml2) {
    setStatus("Upload both XML files before merging.", true);
    return;
  }

  const mergedRootName = "MergedXML";
  const insertion = state.insertionTime;
  const xml1Slice = state.xml1.points.filter((point) => point.time <= insertion);
  const xml2Shifted = state.xml2.points.map((point) => ({
    ...point,
    time: point.time + insertion,
  }));

  const lines = [`<${mergedRootName}>`];
  const segments = [{ line: lines.length, source: "xml1" }];
  xml1Slice.forEach((point) => {
    lines.push(`  <!-- XML1 @ ${formatTime(point.time)} -->`);
    lines.push(`  ${point.xml}`);
  });

  lines.push(`  <!-- XML2 starts at ${formatTime(insertion)} -->`);
  segments.push({ line: lines.length + 1, source: "xml2" });
  xml2Shifted.forEach((point) => {
    lines.push(`  <!-- XML2 @ ${formatTime(point.time)} -->`);
    lines.push(`  ${point.xml}`);
  });
  lines.push(`</${mergedRootName}>`);

  state.mergedText = lines.join("\n");
  state.mergedSegments = buildLineSourceMap(lines, segments);

  renderPreview(lines, state.mergedSegments);
  elements.exportButton.disabled = false;
  setStatus(
    `Merged preview generated. XML1 entries: ${xml1Slice.length}; XML2 entries: ${xml2Shifted.length}.`,
    false
  );
}

function buildLineSourceMap(lines, segmentStarts) {
  const sourceByLine = [];
  let segmentIndex = 0;
  let activeSource = "xml1";
  const ordered = [...segmentStarts].sort((a, b) => a.line - b.line);
  for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
    while (segmentIndex < ordered.length && lineNum >= ordered[segmentIndex].line) {
      activeSource = ordered[segmentIndex].source;
      segmentIndex += 1;
    }
    sourceByLine.push(activeSource);
  }
  return sourceByLine;
}

function renderPreview(lines, sourceByLine) {
  const pre = document.createElement("pre");
  pre.className = "preview-code";

  lines.forEach((lineText, index) => {
    const line = document.createElement("span");
    line.className = `line ${sourceByLine[index] || "xml1"}`;
    line.textContent = lineText;
    pre.appendChild(line);
  });

  elements.previewWindow.innerHTML = "";
  elements.previewWindow.appendChild(pre);
}

function exportMergedXml() {
  if (!state.mergedText) {
    setStatus("Generate a merge preview before exporting.", true);
    return;
  }

  const fileName1 = state.xml1?.fileName.replace(/\.xml$/i, "") || "xml1";
  const fileName2 = state.xml2?.fileName.replace(/\.xml$/i, "") || "xml2";
  const outputName = `${fileName1}_plus_${fileName2}_merged.xml`;
  const blob = new Blob([state.mergedText], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = outputName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus(`Exported merged XML as ${outputName}.`, false, true);
}

function setStatus(message, isError = false, isSuccess = false) {
  elements.status.textContent = message;
  elements.status.classList.remove("error", "success");
  if (isError) {
    elements.status.classList.add("error");
  }
  if (isSuccess) {
    elements.status.classList.add("success");
  }
}
