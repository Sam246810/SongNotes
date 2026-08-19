import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { reconstructPageText } from './pdfTextLayout';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

/**
 * Extracts text from a PDF, reconstructing line breaks and an approximate
 * column alignment from each text item's on-page position — see
 * pdfTextLayout.js's reconstructPageText for the actual layout logic.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<string>}
 */
export async function extractTextFromPdf(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({
    data: arrayBuffer,
    // PDF import is this app's main untrusted-input surface -- users open files they
    // didn't create. `isEvalSupported: false` stops pdf.js from using `new Function()`
    // when handling embedded fonts and CMaps (the mechanism behind CVE-2024-4367, which
    // this version is well clear of, but the option costs nothing and removes the class
    // of bug). It also means the app never needs 'unsafe-eval' in its CSP.
    // The auto-fetch/stream options keep parsing entirely local: a crafted PDF can't
    // make the client reach out for external resources.
    isEvalSupported: false,
    disableAutoFetch: true,
    disableStream: true,
  }).promise;
  const pageTexts = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    pageTexts.push(reconstructPageText(content.items));
  }

  return pageTexts.join('\n\n');
}
