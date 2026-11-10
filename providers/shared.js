// Loaded before each provider's page file, in the same isolated world.
(() => {
  const isPdf = (bytes) => String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  function toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  }
  // Bytes as what fetchPdf answers: a PDF, or why it is not one.
  function pdfResult(bytes) {
    if (!isPdf(bytes)) return { ok: false, why: "That was not a PDF." };
    return { ok: true, size: bytes.length, base64: toBase64(bytes) };
  }
  globalThis.__sweepPdf = { isPdf, toBase64, pdfResult };

  // A recipe's own short line for the run log (log.js), such as which layout
  // it saw or why it stopped: never the page's text. Kept in the page, since
  // this file is loaded again before each call, until the engine takes them
  // with the next answer of readList, clickDoc or nextView (__sweepCarry).
  // At most the last 200 wait, each cut to 300 characters.
  const lines = (globalThis.__sweepLogLines = globalThis.__sweepLogLines || []);
  globalThis.__sweepLog = (text) => {
    try {
      if (lines.length >= 200) lines.shift();
      lines.push(String(text).slice(0, 300));
    } catch (e) { /* a log line never breaks a sweep */ }
  };
  // An answer with the lines waiting added as `log`, and the lines let go.
  globalThis.__sweepCarry = (result) => {
    if (!lines.length || !result || typeof result !== "object" || Array.isArray(result)) return result;
    return { ...result, log: lines.splice(0) };
  };
})();
