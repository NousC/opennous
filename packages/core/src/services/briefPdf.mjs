// An automation's document as a PDF, for the email attachment (GET-497).
//
// THE ATTACHMENT USED TO BE AN .html FILE. It opened in a browser, which is fine on a laptop
// and wrong everywhere a brief actually gets read and forwarded: a phone's mail app shows it as
// source or refuses it, and nobody forwards "report.html" to a colleague. A PDF opens the same
// way on every device.
//
// It reads like the brief in the app: a title, the date, then each section as a heading over
// plain text and bullets. The citation tokens are dropped — in the app they open a source, on
// paper they are noise. pdfkit with the built-in Helvetica, so there is no font file and no
// browser in the image.
import PDFDocument from 'pdfkit';

const INK = '#1c1b19';
const MUTED = '#6f6961';
const RULE = '#e6e2d8';

/**
 * The OpenNous mark, drawn rather than embedded: four orange blocks. Same path as
 * apps/frontend/public/nous-logo.svg (viewBox 143 96 1040 1040), so it is sharp at any zoom and needs
 * no image file in the worker image.
 */
const MARK_PATH = 'M236 272H481A46 46 0 0 1 527 318V542A46 46 0 0 1 481 588H236A46 46 0 0 1 190 542V318A46 46 0 0 1 236 272ZM621 120H1121A46 46 0 0 1 1167 166V646A46 46 0 0 1 1121 692H768A46 46 0 0 1 722 646V574A34 34 0 0 0 688 540H621A46 46 0 0 1 575 494V166A46 46 0 0 1 621 120ZM206 635H474A46 46 0 0 1 520 681V738A34 34 0 0 0 554 772H642A46 46 0 0 1 688 818V1066A46 46 0 0 1 642 1112H206A46 46 0 0 1 160 1066V681A46 46 0 0 1 206 635ZM774 740H1058A46 46 0 0 1 1104 786V1017A46 46 0 0 1 1058 1063H774A46 46 0 0 1 728 1017V786A46 46 0 0 1 774 740Z';
function drawMark(pdf, x, y, size) {
  pdf.save();
  pdf.translate(x, y).scale(size / 1040).translate(-143, -96);
  pdf.path(MARK_PATH).fillColor('#F4512F').fill();
  pdf.restore();
}

// The built-in fonts only carry WinAnsi. A character outside it prints as garbage, so the
// few that turn up in model prose are spelled out and anything else is dropped.
const WIN_ANSI_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
function printable(text) {
  return String(text ?? '')
    .replace(/[→⇒]/g, '->').replace(/[←]/g, '<-').replace(/[≥]/g, '>=').replace(/[≤]/g, '<=')
    .replace(/[≈]/g, '~').replace(/[   ]/g, ' ')
    .split('').filter(c => c.charCodeAt(0) < 256 || WIN_ANSI_EXTRA.has(c)).join('');
}

/** One line of the brief, without its citation tokens or markdown emphasis. */
function clean(line) {
  return printable(line.replace(/\s*\[c[0-9a-z]{4}\]/g, '').replace(/\*\*/g, '').trim());
}

/** Paragraphs and bullet runs out of a section body. */
function blocks(body) {
  const out = [];
  for (const raw of String(body ?? '').split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const m = /^(?:[-·*•]|\d+[.)])\s+(.*)$/.exec(l);
    const text = clean(m ? m[1] : l);
    if (!text) continue;
    const last = out[out.length - 1];
    if (m && last?.list) last.items.push(text);
    else out.push({ list: Boolean(m), items: [text] });
  }
  return out;
}

/**
 * Render a document { title, sections: [{ label, body }] } as a PDF.
 * Sections without a text body (charts, metric tiles) are left out.
 * @returns {Promise<Buffer>}
 */
export function renderDocumentPdf(doc, { writtenAt = new Date() } = {}) {
  // "Quarry Ridge Labs — closed won" → "Quarry Ridge Labs — Account Brief". The status is the first line
  // of the Executive Summary; the title names the account and what this is.
  const account = String(doc.title ?? '').split(/\s+[—–]\s+/)[0].trim();
  const title = account ? `${account} — Account Brief` : 'Account Brief';
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'LETTER',
      margins: { top: 64, bottom: 72, left: 68, right: 68 },
      info: { Title: printable(title), Author: 'OpenNous' },
      // Pages stay in memory so the footer, which needs the page count, is drawn at the end.
      bufferPages: true,
    });
    const chunks = [];
    pdf.on('data', c => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const width = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
    const left = pdf.page.margins.left;

    // HEADER: the mark and the name on the left, what this is on the right, a hairline under.
    const top = pdf.page.margins.top - 26;
    drawMark(pdf, left, top - 1, 18);
    pdf.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('OpenNous', left + 24, top + 3, { lineBreak: false });
    const date = new Date(writtenAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    pdf.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text(date, left, top + 5, { width, align: 'right', lineBreak: false });
    pdf.moveTo(left, top + 26).lineTo(left + width, top + 26).lineWidth(0.6).strokeColor(RULE).stroke();

    // TITLE. The orange lives in the mark; the title stands on its own.
    pdf.y = top + 52;
    pdf.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(printable(title), left, pdf.y, { width });
    pdf.moveDown(0.5);

    for (const sec of doc.sections ?? []) {
      if (typeof sec?.body !== 'string' || !sec.body.trim()) continue;
      const parts = blocks(sec.body);
      if (!parts.length) continue;
      // Keep a heading with at least the start of its section.
      if (pdf.y > pdf.page.height - pdf.page.margins.bottom - 70) pdf.addPage();
      pdf.moveDown(0.7);
      if (sec.label) {
        pdf.font('Helvetica-Bold').fontSize(11.5).fillColor(INK).text(printable(sec.label), left, pdf.y, { width });
        pdf.moveDown(0.35);
      }
      pdf.font('Helvetica').fontSize(10.5).fillColor(INK);
      // A LINE THAT WILL NOT FIT STARTS THE NEXT PAGE. Left to itself pdfkit breaks the text
      // and not the bullet beside it, so a bullet at the foot of a page printed alone and its
      // words landed two pages on.
      const fit = (text, w) => {
        const h = pdf.heightOfString(text, { width: w, lineGap: 2.5 });
        if (pdf.y + h > pdf.page.height - pdf.page.margins.bottom) pdf.addPage();
      };
      for (const b of parts) {
        if (b.list) {
          for (const item of b.items) {
            fit(item, width - 16);
            const y = pdf.y;
            pdf.text('•', left + 2, y, { width: 12, lineGap: 2.5 });
            pdf.text(item, left + 16, y, { width: width - 16, lineGap: 2.5 });
            pdf.moveDown(0.25);
          }
        } else {
          fit(b.items[0], width);
          pdf.text(b.items[0], left, pdf.y, { width, lineGap: 2.5 });
          pdf.moveDown(0.5);
        }
      }
    }
    // FOOTER on every page: the name and address on the left, the page on the right. The
    // bottom margin is lifted while it is drawn, or pdfkit would start a new page for it.
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      const bottom = pdf.page.margins.bottom;
      pdf.page.margins.bottom = 0;
      const y = pdf.page.height - 44;
      pdf.moveTo(left, y - 10).lineTo(left + width, y - 10).lineWidth(0.6).strokeColor(RULE).stroke();
      drawMark(pdf, left, y - 3, 10);
      pdf.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text('OpenNous  ·  opennous.cloud', left + 14, y - 1, { lineBreak: false });
      pdf.text(`${i - range.start + 1} / ${range.count}`, left, y - 1, { width, align: 'right', lineBreak: false });
      pdf.page.margins.bottom = bottom;
    }
    pdf.end();
  });
}
