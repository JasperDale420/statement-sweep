// Where a saved document goes and what it is called. The engine and the
// Settings page both use this, so the preview is what really happens.
//
// A pattern is plain words with {fields}, and [optional parts] that are left
// out when a field inside them has no value. Chrome saves only inside its
// Downloads folder, so a path here is always relative to that.

export const DEFAULT_NAMING = { base: "Statement Sweep", folder: "{provider}", file: "", providers: {} };
export const FIELDS = ["date", "year", "month", "day", "provider", "title"];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DATE_PART = /yyyy|yy|mmmm|mmm|mm|dd/g;
const LONGEST_PART = 120;

function parse(pattern) {
  const nodes = [];
  let optional = null;
  let text = "";
  const flush = () => {
    if (text) (optional || nodes).push({ text });
    text = "";
  };
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end < 0) throw new Error('A "{" has no closing "}".');
      const [name, format] = pattern.slice(i + 1, end).split(":", 2).map((s) => s.trim());
      if (!FIELDS.includes(name)) throw new Error(`There is no field called {${name}}. Use one of: ${FIELDS.map((f) => `{${f}}`).join(" ")}.`);
      if (format !== undefined && name !== "date") throw new Error(`Only {date} can have a format, not {${name}}.`);
      if (format !== undefined && !format.match(DATE_PART)) throw new Error(`{date:${format}} has no date parts. Use yyyy, yy, mmmm, mmm, mm or dd.`);
      flush();
      (optional || nodes).push({ field: name, format });
      i = end;
    } else if (ch === "}") {
      throw new Error('A "}" has no opening "{".');
    } else if (ch === "[") {
      if (optional) throw new Error("Optional [parts] cannot go inside each other.");
      flush();
      optional = [];
    } else if (ch === "]") {
      if (!optional) throw new Error('A "]" has no opening "[".');
      flush();
      nodes.push({ optional });
      optional = null;
    } else {
      text += ch;
    }
  }
  if (optional) throw new Error('A "[" has no closing "]".');
  flush();
  return nodes;
}

function formatted(iso, format) {
  const [yyyy, mm, dd] = iso.split("-");
  if (!dd) return iso;
  const month = MONTHS[Number(mm) - 1] || mm;
  const parts = { yyyy, yy: yyyy.slice(2), mmmm: month, mmm: month.slice(0, 3), mm, dd };
  return format.replace(DATE_PART, (part) => parts[part]);
}

const valueOf = (node, fields) => {
  const value = fields[node.field] || "";
  return value && node.format ? formatted(value, node.format) : value;
};

function render(nodes, fields) {
  return nodes.map((node) => {
    if (node.text) return node.text;
    if (node.field) return valueOf(node, fields);
    return node.optional.some((n) => n.field && !valueOf(n, fields)) ? "" : render(node.optional, fields);
  }).join("");
}

// One folder or file name. Chrome refuses a path with an illegal part, so a
// value can neither break a save nor make a folder of its own.
const clean = (text) => text.replace(/[/\\:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, " ").replace(/^[. ]+/, "").trim().slice(0, LONGEST_PART).replace(/[. ]+$/, "");

// "" when the pattern is good, or what is wrong with it.
export function checkPattern(pattern, { isFile = false } = {}) {
  if (isFile && pattern.includes("/")) return "A file name cannot contain /. Put folders in the folder pattern.";
  try {
    pattern.split("/").forEach(parse);
    return "";
  } catch (e) {
    return e.message;
  }
}

export function normalise(stored) {
  const given = stored && typeof stored === "object" ? stored : {};
  return {
    base: typeof given.base === "string" ? given.base : DEFAULT_NAMING.base,
    folder: typeof given.folder === "string" ? given.folder : DEFAULT_NAMING.folder,
    file: typeof given.file === "string" ? given.file : DEFAULT_NAMING.file,
    providers: given.providers && typeof given.providers === "object" ? given.providers : {},
  };
}

// A provider's own pattern when it has one, and otherwise the general one.
function effective(naming, id) {
  const own = naming.providers[id] || {};
  return { base: naming.base, folder: own.folder || naming.folder, file: own.file || naming.file };
}

function folders(pattern, fields) {
  return pattern.split("/").map((part) => clean(render(parse(part), fields))).filter(Boolean);
}

const fieldsOf = (provider, doc) => {
  const [year = "", month = "", day = ""] = (doc.date || "").split("-");
  return { date: doc.date || "", year, month, day, provider: provider.name, title: doc.title || "" };
};

// The provider's own name for a document, used until you set a pattern.
const providersOwnName = (provider, doc) => provider.fileName.replace("{date}", doc.date).replace("{title}", doc.title || "Document")
  .replace("{id}", doc.id).replace(/[/\\:*?"<>|]/g, "-");

export function pathFor(stored, provider, doc) {
  const naming = effective(normalise(stored), provider.id);
  const fields = fieldsOf(provider, doc);
  // Folder names have always left out marks such as the & of SDG&E.
  const dirFields = { ...fields, provider: provider.name.replace(/[^A-Za-z0-9 ]/g, "") };
  const dir = [...folders(naming.base, dirFields), ...folders(naming.folder, dirFields)];
  let name;
  if (naming.file) {
    const stem = clean(render(parse(naming.file), fields).replace(/\.pdf$/i, "")) || "Document";
    name = `${stem}.pdf`;
  } else {
    name = providersOwnName(provider, doc);
  }
  return [...dir, name].join("/");
}
