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
})();
