import { PROVIDERS } from "./providers/index.js";
import { DEFAULT_NAMING, checkPattern, normalise, pathFor } from "./naming.js";

const $ = (id) => document.getElementById(id);
const SAMPLE = { id: "sample", date: "2026-10-28", title: "Monthly Statement" };
const INHERIT = "__inherit", CUSTOM = "__custom";
const FOLDER_PRESETS = [["{provider}", "By Site"], ["{provider}/{year}", "By Site and Year"], ["{year}", "By Year"], ["", "All in One Folder"]];
const FILE_PRESETS = [["", "Each Site's Usual Name"], ["{date} {provider}[ {title}]", "Date, Site, Title"], ["{date:yyyy-mm} {provider}[ {title}]", "Year and Month, Site, Title"], ["{provider} {date}[ {title}]", "Site, Date, Title"]];
const PRESETS = { folder: FOLDER_PRESETS, file: FILE_PRESETS };
let lastPattern = "file";

let draft = normalise((await chrome.storage.local.get("naming")).naming);
let dirty = false;

const scope = () => $("scope").value;
const inherit = () => normalise(draft);

function own(id) {
  draft.providers[id] = draft.providers[id] || {};
  return draft.providers[id];
}

// Every pattern, not only those on show, since Save stores them all.
function firstProblem() {
  const checks = [["Main folder", draft.base, false], ["Folder pattern", draft.folder, false], ["File name pattern", draft.file, true]];
  for (const provider of PROVIDERS) {
    const set = draft.providers[provider.id];
    if (set) checks.push([`${provider.name} folder pattern`, set.folder || "", false], [`${provider.name} file name pattern`, set.file || "", true]);
  }
  for (const [label, pattern, isFile] of checks) {
    const problem = checkPattern(pattern, { isFile });
    if (problem) return `${label}: ${problem}`;
  }
  return "";
}

function showStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").dataset.kind = kind;
}

function drawPreview() {
  const problem = firstProblem();
  $("problem").textContent = problem;
  $("save").disabled = Boolean(problem);
  const provider = PROVIDERS.find((p) => p.id === scope()) || PROVIDERS.find((p) => p.id === "amex") || PROVIDERS[0];
  $("previewhead").textContent = `Example for ${provider.name}`;
  $("preview").textContent = problem ? "" : pathFor(inherit(), provider, SAMPLE);
}

// The menu above a pattern shows the preset it matches, or Custom.
function drawPreset(field) {
  const id = scope();
  const value = $(field).value;
  const menu = $(`${field}Preset`);
  const presets = PRESETS[field];
  // A preset whose pattern is blank means "inherit" when one site is chosen.
  const shown = id ? presets.filter(([pattern]) => pattern) : presets;
  const options = [...(id ? [new Option("Same as All Sites", INHERIT)] : []), ...shown.map(([pattern, label]) => new Option(label, pattern))];
  const known = (id && !value) || shown.some(([pattern]) => pattern === value);
  if (!known) options.push(new Option("Custom", CUSTOM));
  menu.replaceChildren(...options);
  menu.value = id && !value ? INHERIT : known ? value : CUSTOM;
}

function drawFields() {
  const id = scope();
  const set = id ? draft.providers[id] || {} : draft;
  $("folder").value = set.folder || (id ? "" : draft.folder);
  $("file").value = set.file || (id ? "" : draft.file);
  $("folder").placeholder = id ? (draft.folder || "No subfolder") : "No subfolder";
  $("file").placeholder = id ? (draft.file || "This site's usual name") : "Each site's usual name";
  $("filehint").textContent = id ? "Blank uses the pattern set for all sites." : "";
  drawPreset("folder");
  drawPreset("file");
  drawPreview();
}

function setPattern(field, value) {
  const id = scope();
  if (id) own(id)[field] = value;
  else draft[field] = value;
}

function changed() {
  dirty = true;
  showStatus("Not saved yet");
  drawPreview();
}

$("base").addEventListener("input", () => { draft.base = $("base").value; changed(); });
for (const field of ["folder", "file"]) {
  $(field).addEventListener("focus", () => { lastPattern = field; });
  $(field).addEventListener("input", () => {
    setPattern(field, $(field).value);
    drawPreset(field);
    changed();
  });
  $(`${field}Preset`).addEventListener("change", () => {
    const value = $(`${field}Preset`).value;
    if (value === CUSTOM) return;
    $(field).value = value === INHERIT ? "" : value;
    setPattern(field, $(field).value);
    drawPreset(field);
    changed();
  });
}

// Inserts at the caret of the pattern field last used, keeping its focus.
document.getElementById("insert").addEventListener("mousedown", (e) => { if (e.target.closest(".chip")) e.preventDefault(); });
document.getElementById("insert").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const input = $(lastPattern);
  const at = input.selectionStart ?? input.value.length;
  input.setRangeText(chip.dataset.insert, at, input.selectionEnd ?? at, "end");
  input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
$("scope").addEventListener("change", drawFields);

$("save").addEventListener("click", async () => {
  if (firstProblem()) return;
  await chrome.storage.local.set({ naming: draft });
  dirty = false;
  showStatus("Saved", "ok");
});

$("reset").addEventListener("click", () => {
  draft = normalise({ ...DEFAULT_NAMING, providers: {} });
  $("base").value = draft.base;
  $("scope").value = "";
  drawFields();
  dirty = true;
  showStatus("Defaults restored. Press Save to keep them.");
});

window.addEventListener("beforeunload", (e) => { if (dirty) e.preventDefault(); });

$("scope").replaceChildren(new Option("All Sites", ""), ...PROVIDERS.map((p) => new Option(p.name, p.id)));
$("base").value = draft.base;
drawFields();
