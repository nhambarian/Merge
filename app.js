const state = {
  xml1: null,
  xml2: null,
  insertionTime: 0,
  mergedText: "",
  mergedSegments: [],
};

const BROADCAST_DF = {
  frameRate: 59.94,
  nominalFps: 60,
  dropFrames: 4,
  minutesPerDay: 24 * 60,
};

const DAY_SECONDS = 24 * 60 * 60;

const elements = {
  dropZones: document.querySelectorAll(".drop-zone"),
  xml1Input: document.getElementById("xml1-input"),
  xml2Input: document.getElementById("xml2-input"),
  xml1Meta: document.getElementById("xml1-meta"),
  xml2Meta: document.getElementById("xml2-meta"),
  insertionSlider: document.getElementById("insertion-slider"),
  insertionTime: document.getElementById("insertion-time"),
  selectedTimeDisplay: document.getElementById("selected-time-display"),
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
  updateSelectedTimeDisplay();
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

  const modeMessage =
    parsed.mode === "bxf-asrun"
      ? "BXF AsRun mode enabled with broadcast-time timeline."
      : parsed.timelineMode === "synthetic"
        ? "No explicit timestamps found, using ordered sequence positions."
        : "Detected explicit timestamps.";
  setStatus(`${target.toUpperCase()} loaded: ${file.name}. ${modeMessage}`, false);
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

  const lineCount = xmlText.split(/\r?\n/).length;
  const bxfParsed = tryParseBxfAsRun(doc);
  if (bxfParsed) {
    return {
      fileName,
      xmlText,
      rootName: root.tagName,
      lineCount,
      ...bxfParsed,
    };
  }

  const points = extractGenericTimedPoints(root);
  if (points.length === 0) {
    throw new Error(`"${fileName}" has no mergeable child elements under <${root.tagName}>.`);
  }

  fillMissingPointTimes(points);
  const duration = Math.max(...points.map((point) => point.time));
  const timelineMode = points.some((point) => point.explicitTime) ? "timed" : "synthetic";

  return {
    mode: "generic",
    fileName,
    xmlText,
    rootName: root.tagName,
    points,
    duration,
    lineCount,
    timelineMode,
    hasAnchor: false,
    anchorSeconds: 0,
    xmlDoc: doc,
  };
}

function tryParseBxfAsRun(doc) {
  const schedule = findScheduleElement(doc);
  if (!schedule) {
    return null;
  }

  const asRunNodes = Array.from(schedule.children).filter((child) => child.tagName === "AsRun");
  if (asRunNodes.length === 0) {
    return null;
  }

  const serializer = new XMLSerializer();
  const anchorSeconds = parseScheduleAnchorSeconds(schedule.getAttribute("scheduleStart"));
  const hasAnchor = anchorSeconds !== null;

  const points = asRunNodes.map((node, index) => {
    const startTimecode = findAsRunStartTimecode(node);
    const absoluteStart = startTimecode ? parseFlexibleTime(startTimecode) : null;
    const relativeStart =
      absoluteStart === null
        ? null
        : hasAnchor
          ? toRelativeScheduleSeconds(absoluteStart, anchorSeconds)
          : absoluteStart;

    return {
      time: relativeStart,
      explicitTime: relativeStart !== null,
      order: index,
      nodeName: node.tagName,
      xml: serializer.serializeToString(node),
      sourceNode: node,
      startTimecode,
    };
  });

  fillMissingPointTimes(points);
  const duration = Math.max(...points.map((point) => point.time));
  const timelineMode = points.some((point) => point.explicitTime) ? "timed" : "synthetic";

  return {
    mode: "bxf-asrun",
    points,
    duration,
    timelineMode,
    hasAnchor,
    anchorSeconds: hasAnchor ? anchorSeconds : 0,
    xmlDoc: doc,
  };
}

function findScheduleElement(doc) {
  return doc.querySelector("BxfData > Schedule") || doc.querySelector("Schedule");
}

function findAsRunStartTimecode(asRunNode) {
  const match = asRunNode.querySelector(
    "AsRunDetail StartDateTime SmpteDateTime SmpteTimeCode, AsRunDetail StartDateTime SmpteTimeCode"
  );
  return match?.textContent?.trim() || "";
}

function parseScheduleAnchorSeconds(scheduleStart) {
  if (!scheduleStart) {
    return null;
  }
  const isoMatch = scheduleStart.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (isoMatch) {
    return Number(isoMatch[1]) * 3600 + Number(isoMatch[2]) * 60 + Number(isoMatch[3]);
  }
  const hmsMatch = scheduleStart.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (hmsMatch) {
    return Number(hmsMatch[1]) * 3600 + Number(hmsMatch[2]) * 60 + Number(hmsMatch[3]);
  }
  return null;
}

function extractGenericTimedPoints(root) {
  const nodes = Array.from(root.children);
  const serializer = new XMLSerializer();

  if (nodes.length === 0) {
    return [];
  }

  return nodes.map((node, index) => {
    const time = getTimeFromElement(node);
    return {
      time,
      explicitTime: time !== null,
      order: index,
      nodeName: node.tagName,
      xml: serializer.serializeToString(node),
      sourceNode: node,
      startTimecode: "",
    };
  });
}

function fillMissingPointTimes(points) {
  if (points.length === 0) {
    return;
  }

  const hasExplicitTimes = points.some((point) => point.explicitTime);
  if (!hasExplicitTimes) {
    points.forEach((point, index) => {
      point.time = index;
    });
    return;
  }

  let lastKnown = 0;
  let seenKnown = false;
  points.forEach((point) => {
    if (point.time !== null) {
      seenKnown = true;
      lastKnown = point.time;
      return;
    }
    point.time = seenKnown ? lastKnown + 0.001 : 0;
    lastKnown = point.time;
  });
}

function getTimeFromElement(node) {
  const directAttributeKeys = ["time", "start", "timestamp", "t", "begin", "offset", "pts"];
  for (const attr of directAttributeKeys) {
    const value = node.getAttribute(attr);
    if (value === null) {
      continue;
    }
    const parsed = parseFlexibleTime(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  const fuzzyAttributeKeywords = ["time", "start", "begin", "stamp", "offset", "pts", "sec", "ms"];
  for (const attribute of Array.from(node.attributes)) {
    const lowerName = attribute.name.toLowerCase();
    if (!fuzzyAttributeKeywords.some((keyword) => lowerName.includes(keyword))) {
      continue;
    }
    const parsed = parseFlexibleTime(attribute.value);
    if (parsed !== null) {
      return parsed;
    }
  }

  const timeChildKeywords = ["time", "start", "begin", "timestamp", "offset", "pts", "sec", "ms"];
  for (const child of Array.from(node.children)) {
    const lowerTag = child.tagName.toLowerCase();
    if (!timeChildKeywords.some((keyword) => lowerTag.includes(keyword))) {
      continue;
    }
    const parsed = parseFlexibleTime(child.textContent || "");
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function parseFlexibleTime(input) {
  if (typeof input !== "string" && typeof input !== "number") {
    return null;
  }

  const value = String(input).trim().replace(",", ".");
  if (!value) {
    return null;
  }

  const dropFrameParsed = parseDropFrame59_94(value);
  if (dropFrameParsed !== null) {
    return dropFrameParsed;
  }

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : null;
  }

  const unitMatch = value.match(/^(-?\d+(?:\.\d+)?)\s*(ms|msec|s|sec|secs|m|min|mins|h|hr|hrs)$/i);
  if (unitMatch) {
    const amount = Number(unitMatch[1]);
    if (!Number.isFinite(amount)) {
      return null;
    }
    const unit = unitMatch[2].toLowerCase();
    if (unit === "ms" || unit === "msec") {
      return Math.max(0, amount / 1000);
    }
    if (unit === "s" || unit === "sec" || unit === "secs") {
      return Math.max(0, amount);
    }
    if (unit === "m" || unit === "min" || unit === "mins") {
      return Math.max(0, amount * 60);
    }
    return Math.max(0, amount * 3600);
  }

  const isoMatch = value.match(
    /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i
  );
  if (isoMatch) {
    const hours = Number(isoMatch[1] || 0);
    const minutes = Number(isoMatch[2] || 0);
    const seconds = Number(isoMatch[3] || 0);
    if (![hours, minutes, seconds].every((n) => Number.isFinite(n))) {
      return null;
    }
    return Math.max(0, hours * 3600 + minutes * 60 + seconds);
  }

  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const numeric = parts.map((part) => Number(part));
  if (numeric.some((n) => !Number.isFinite(n))) {
    return null;
  }

  if (parts.length === 3) {
    return Math.max(0, numeric[0] * 3600 + numeric[1] * 60 + numeric[2]);
  }
  return Math.max(0, numeric[0] * 60 + numeric[1]);
}

function parseDropFrame59_94(value) {
  const match = value.match(/^(\d{1,2}):([0-5]\d):([0-5]\d)([:;])([0-5]\d)$/);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const separator = match[4];
  const frames = Number(match[5]);
  if (![hours, minutes, seconds, frames].every((n) => Number.isInteger(n))) {
    return null;
  }

  if (separator === ";") {
    const isTenthMinute = minutes % 10 === 0;
    if (!isTenthMinute && seconds === 0 && frames < BROADCAST_DF.dropFrames) {
      return null;
    }
  }

  const totalMinutes = hours * 60 + minutes;
  const nominalFrameNumber =
    (hours * 3600 + minutes * 60 + seconds) * BROADCAST_DF.nominalFps + frames;

  if (separator === ";") {
    const dropped =
      BROADCAST_DF.dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
    return Math.max(0, (nominalFrameNumber - dropped) / BROADCAST_DF.frameRate);
  }
  return Math.max(0, nominalFrameNumber / BROADCAST_DF.frameRate);
}

function formatDropFrame59_94(secondsValue) {
  const frameCount = Math.max(0, Math.round(secondsValue * BROADCAST_DF.frameRate));
  const nominalFps = BROADCAST_DF.nominalFps;
  const dropFrames = BROADCAST_DF.dropFrames;
  const framesPerMinuteNominal = nominalFps * 60;
  const framesPerMinuteDropped = framesPerMinuteNominal - dropFrames;
  const framesPerTenMinutes = framesPerMinuteNominal + framesPerMinuteDropped * 9;
  const framesPer24Hours = framesPerTenMinutes * 144;

  let remaining = frameCount % framesPer24Hours;
  const tenMinuteBlocks = Math.floor(remaining / framesPerTenMinutes);
  remaining %= framesPerTenMinutes;

  let minuteInBlock = 0;
  let frameOfMinute = 0;
  if (remaining < framesPerMinuteNominal) {
    minuteInBlock = 0;
    frameOfMinute = remaining;
  } else {
    remaining -= framesPerMinuteNominal;
    minuteInBlock = 1 + Math.floor(remaining / framesPerMinuteDropped);
    frameOfMinute = remaining % framesPerMinuteDropped;
  }

  const totalMinutes = tenMinuteBlocks * 10 + minuteInBlock;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const labelFrameOfMinute = minuteInBlock === 0 ? frameOfMinute : frameOfMinute + dropFrames;
  const secs = Math.floor(labelFrameOfMinute / nominalFps);
  const frames = labelFrameOfMinute % nominalFps;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    secs
  ).padStart(2, "0")};${String(frames).padStart(2, "0")}`;
}

function normalizeDaySeconds(seconds) {
  return ((seconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
}

function toRelativeScheduleSeconds(absoluteSeconds, anchorSeconds) {
  return normalizeDaySeconds(absoluteSeconds - anchorSeconds);
}

function toAbsoluteClockSeconds(relativeSeconds, anchorSeconds) {
  return normalizeDaySeconds(relativeSeconds + anchorSeconds);
}

function looksLikeBroadcastTimecode(value) {
  return /^\d{1,2}:[0-5]\d:[0-5]\d[:;][0-5]\d$/.test(value.trim());
}

function parseInsertionTime(inputValue, parsedFile) {
  const value = inputValue.trim();
  if (!value) {
    return null;
  }

  if (parsedFile?.mode === "bxf-asrun" && parsedFile.hasAnchor && looksLikeBroadcastTimecode(value)) {
    const absolute = parseDropFrame59_94(value);
    if (absolute === null) {
      return null;
    }
    return toRelativeScheduleSeconds(absolute, parsedFile.anchorSeconds);
  }
  return parseFlexibleTime(value);
}

function formatDisplayTime(seconds, parsedFile) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00:00;00";
  }

  if (parsedFile?.mode === "bxf-asrun" && parsedFile.hasAnchor) {
    const absolute = toAbsoluteClockSeconds(seconds, parsedFile.anchorSeconds);
    return formatDropFrame59_94(absolute);
  }
  return formatDropFrame59_94(seconds);
}

function updateFileMeta(target, parsed) {
  const metaElement = target === "xml1" ? elements.xml1Meta : elements.xml2Meta;
  const timelineLabel =
    parsed.timelineMode === "timed" ? "Timeline: explicit timestamps" : "Timeline: auto sequence";
  const windowLabel =
    parsed.mode === "bxf-asrun" && parsed.hasAnchor
      ? ` | Window: ${formatDisplayTime(0, parsed)} -> ${formatDisplayTime(parsed.duration, parsed)}`
      : "";

  metaElement.textContent = `${parsed.fileName} | Root: <${parsed.rootName}> | Timed nodes: ${
    parsed.points.length
  } | Duration: ${formatDropFrame59_94(parsed.duration)} | ${timelineLabel}${windowLabel}`;
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
    updateSelectedTimeDisplay();
    return;
  }

  const duration1 = Math.max(0, state.xml1.duration);
  elements.insertionSlider.max = String(duration1);
  elements.insertionSlider.step = "0.001";
  elements.insertionSlider.value = String(Math.min(state.insertionTime, duration1));
  state.insertionTime = Number(elements.insertionSlider.value);
  elements.insertionTime.value = formatDisplayTime(state.insertionTime, state.xml1);
  updateSelectedTimeDisplay();
  renderTimelineSummary();
}

function onSliderChange() {
  state.insertionTime = Number(elements.insertionSlider.value);
  elements.insertionTime.value = formatDisplayTime(state.insertionTime, state.xml1);
  updateSelectedTimeDisplay();
  renderTimelineSummary();
}

function onApplyTime() {
  if (!state.xml1) {
    return;
  }

  const parsed = parseInsertionTime(elements.insertionTime.value, state.xml1);
  if (parsed === null) {
    setStatus(
      "Invalid insertion time. Use HH:MM:SS;FF or HH:MM:SS:FF (59.94) or numeric seconds.",
      true
    );
    return;
  }

  const clamped = Math.max(0, Math.min(parsed, state.xml1.duration));
  state.insertionTime = clamped;
  elements.insertionSlider.value = String(clamped);
  elements.insertionTime.value = formatDisplayTime(clamped, state.xml1);
  updateSelectedTimeDisplay();
  renderTimelineSummary();
  setStatus(`Insertion time updated to ${formatDisplayTime(clamped, state.xml1)}.`, false);
}

function updateSelectedTimeDisplay() {
  if (!elements.selectedTimeDisplay) {
    return;
  }
  if (!state.xml1) {
    elements.selectedTimeDisplay.textContent = "--:--:--;--";
    return;
  }
  elements.selectedTimeDisplay.textContent = formatDisplayTime(state.insertionTime, state.xml1);
}

function renderTimelineSummary() {
  if (!state.xml1 || !state.xml2) {
    return;
  }

  elements.timelineSummary.textContent = `XML File 1 timeline: ${formatDisplayTime(
    0,
    state.xml1
  )} to ${formatDisplayTime(state.xml1.duration, state.xml1)} (${state.xml1.timelineMode === "timed" ? "explicit timestamps" : "auto sequence"}). XML File 2 timeline: ${formatDisplayTime(
    0,
    state.xml2
  )} to ${formatDisplayTime(state.xml2.duration, state.xml2)} (${state.xml2.timelineMode === "timed" ? "explicit timestamps" : "auto sequence"}). XML File 2 will start at ${formatDisplayTime(
    state.insertionTime,
    state.xml1
  )}.`;
}

function generateMergePreview() {
  if (!state.xml1 || !state.xml2) {
    setStatus("Upload both XML files before merging.", true);
    return;
  }

  if (state.xml1.mode === "bxf-asrun" && state.xml2.mode === "bxf-asrun") {
    const merged = buildBxfMergedResult(state.xml1, state.xml2, state.insertionTime);
    state.mergedText = merged.exportXml;
    state.mergedSegments = merged.previewSources;
    renderPreview(merged.previewLines, merged.previewSources);
    elements.exportButton.disabled = false;
    setStatus(
      `Merged preview generated. XML1 entries: ${merged.xml1Count}; XML2 entries: ${merged.xml2Count}.`,
      false
    );
    return;
  }

  const insertion = state.insertionTime;
  const xml1Slice = state.xml1.points.filter((point) => point.time < insertion);
  const xml2Suffix = state.xml2.points.filter((point) => point.time >= insertion);

  const lines = ["<MergedXML>"];
  const sourceByLine = [""];

  lines.push(`  <!-- XML2 starts at ${formatDisplayTime(insertion, state.xml1)} -->`);
  sourceByLine.push("");

  xml1Slice.forEach((point) => {
    lines.push(`  <!-- XML1 @ ${formatDisplayTime(point.time, state.xml1)} -->`);
    sourceByLine.push("xml1");
    lines.push(`  ${point.xml}`);
    sourceByLine.push("xml1");
  });

  xml2Suffix.forEach((point) => {
    lines.push(`  <!-- XML2 @ ${formatDisplayTime(point.time, state.xml2)} -->`);
    sourceByLine.push("xml2");
    lines.push(`  ${point.xml}`);
    sourceByLine.push("xml2");
  });
  lines.push("</MergedXML>");
  sourceByLine.push("");

  state.mergedText = lines.join("\n");
  state.mergedSegments = sourceByLine;
  renderPreview(lines, sourceByLine);
  elements.exportButton.disabled = false;
  setStatus(
    `Merged preview generated. XML1 entries: ${xml1Slice.length}; XML2 entries: ${xml2Suffix.length}.`,
    false
  );
}

function buildBxfMergedResult(xml1File, xml2File, insertion) {
  const xml1Prefix = xml1File.points.filter((point) => point.time < insertion);
  const xml2Suffix = xml2File.points.filter((point) => point.time >= insertion);

  const mergedDoc = xml1File.xmlDoc.cloneNode(true);
  const targetSchedule = findScheduleElement(mergedDoc);
  if (!targetSchedule) {
    throw new Error("Unable to find <Schedule> in XML File 1.");
  }

  Array.from(targetSchedule.children)
    .filter((child) => child.tagName === "AsRun")
    .forEach((child) => child.remove());

  xml1Prefix.forEach((point) => {
    targetSchedule.appendChild(mergedDoc.importNode(point.sourceNode, true));
  });
  xml2Suffix.forEach((point) => {
    targetSchedule.appendChild(mergedDoc.importNode(point.sourceNode, true));
  });

  const exportXml = prettyPrintXml(new XMLSerializer().serializeToString(mergedDoc));
  const preview = buildBxfPreview(mergedDoc, xml1Prefix.length, xml2Suffix.length);

  return {
    exportXml,
    previewLines: preview.lines,
    previewSources: preview.sources,
    xml1Count: xml1Prefix.length,
    xml2Count: xml2Suffix.length,
  };
}

function buildBxfPreview(mergedDoc, xml1Count, xml2Count) {
  const previewDoc = mergedDoc.cloneNode(true);
  const schedule = findScheduleElement(previewDoc);
  const asRunNodes = schedule
    ? Array.from(schedule.children).filter((child) => child.tagName === "AsRun")
    : [];

  if (schedule && asRunNodes.length > 0) {
    if (xml1Count > 0) {
      schedule.insertBefore(previewDoc.createComment("SRC:XML1"), asRunNodes[0]);
    }
    if (xml2Count > 0) {
      const xml2StartNode = asRunNodes[xml1Count] || null;
      schedule.insertBefore(previewDoc.createComment("SRC:XML2"), xml2StartNode);
    }
    if (xml1Count === 0 && xml2Count > 0) {
      schedule.insertBefore(previewDoc.createComment("SRC:XML2"), asRunNodes[0]);
    }
  }

  const pretty = prettyPrintXml(new XMLSerializer().serializeToString(previewDoc));
  const lines = [];
  const sources = [];
  let activeSource = "";
  let inAsRun = false;

  pretty.split("\n").forEach((line) => {
    if (line.includes("<!--SRC:XML1-->")) {
      activeSource = "xml1";
      return;
    }
    if (line.includes("<!--SRC:XML2-->")) {
      activeSource = "xml2";
      return;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("<AsRun")) {
      inAsRun = true;
    }

    lines.push(line);
    sources.push(inAsRun ? activeSource : "");

    if (trimmed.startsWith("</AsRun>")) {
      inAsRun = false;
    }
  });

  return { lines, sources };
}

function prettyPrintXml(xml) {
  const compact = xml.replace(/>\s+</g, "><").trim();
  const rawLines = compact.replace(/(>)(<)(\/?)/g, "$1\n$2$3").split("\n");
  const prettyLines = [];
  let depth = 0;

  rawLines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const isClosingTag = /^<\//.test(trimmed);
    if (isClosingTag) {
      depth = Math.max(0, depth - 1);
    }

    prettyLines.push(`${"  ".repeat(depth)}${trimmed}`);

    const isDeclaration = /^<\?/.test(trimmed) || /^<!/.test(trimmed);
    const isSelfClosing = /\/>$/.test(trimmed);
    const isOpenAndCloseSameLine = /^<[^/][^>]*>.*<\/[^>]+>$/.test(trimmed);
    const isOpeningTag = /^<[^/!?][^>]*>$/.test(trimmed);

    if (isOpeningTag && !isDeclaration && !isSelfClosing && !isOpenAndCloseSameLine) {
      depth += 1;
    }
  });

  return prettyLines.join("\n");
}

function renderPreview(lines, sourceByLine) {
  const pre = document.createElement("pre");
  pre.className = "preview-code";

  lines.forEach((lineText, index) => {
    const line = document.createElement("span");
    const sourceClass = sourceByLine[index];
    line.className = sourceClass ? `line ${sourceClass}` : "line";
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
