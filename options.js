import { PROVIDERS } from "./providers/index.js";
import { DEFAULT_NAMING, checkPattern, normalise, pathFor } from "./naming.js";

const $ = (id) => document.getElementById(id);
const SAMPLE = { id: "sample", date: "2026-10-28", title: "Monthly Statement" };
const OWN_NAME = "Blank uses each site's usual name.";

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

function drawFields() {
  const id = scope();
  const set = id ? draft.providers[id] || {} : draft;
  $("folder").value = set.folder || (id ? "" : draft.folder);
  $("file").value = set.file || (id ? "" : draft.file);
  $("folder").placeholder = id ? (draft.folder || "No subfolder") : "No subfolder";
  $("file").placeholder = id ? (draft.file || "This site's usual name") : "Each site's usual name";
  $("filehint").textContent = id ? "Blank uses the pattern set for all sites." : OWN_NAME;
  drawPreview();
}

function changed() {
  dirty = true;
  showStatus("Not saved yet");
  drawPreview();
}

$("base").addEventListener("input", () => { draft.base = $("base").value; changed(); });
for (const field of ["folder", "file"]) {
  $(field).addEventListener("input", () => {
    const id = scope();
    if (id) own(id)[field] = $(field).value;
    else draft[field] = $(field).value;
    changed();
  });
}
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

$("scope").replaceChildren(new Option("All sites", ""), ...PROVIDERS.map((p) => new Option(p.name, p.id)));
$("base").value = draft.base;
drawFields();
