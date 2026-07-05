/**
 * PPTX text extractor — unzips the PPTX (which is a ZIP of XML),
 * reads ppt/slides/slide*.xml files, strips XML tags, returns plain text.
 *
 * PPTX files are NOT PDFs — they are ZIP archives containing Office Open XML.
 * Sending them to Gemini as application/pdf inlineData results in "no pages" errors.
 * This extractor converts PPTX → plain text so the enrichment pipeline can
 * process them through the standard text path.
 */
import { unzipSync } from 'fflate'

/**
 * Extract readable text from a PPTX file buffer.
 * Returns concatenated slide text with XML tags stripped.
 * Returns empty string on any error (corrupt file, no slides, etc.).
 */
export function extractPptxText(buffer: Buffer): string {
  try {
    const unzipped = unzipSync(new Uint8Array(buffer))

    // Find slide files: ppt/slides/slide1.xml, ppt/slides/slide2.xml, etc.
    const slideEntries = Object.keys(unzipped)
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((a, b) => {
        const numA = parseInt(a.match(/slide(\d+)/i)?.[1] ?? '0', 10)
        const numB = parseInt(b.match(/slide(\d+)/i)?.[1] ?? '0', 10)
        return numA - numB
      })

    if (slideEntries.length === 0) return ''

    const slideTexts: string[] = []

    for (const entry of slideEntries) {
      const xml = new TextDecoder().decode(unzipped[entry])
      // Strip all XML tags, collapse whitespace, trim
      const text = xml
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) slideTexts.push(text)
    }

    return slideTexts.join('\n\n')
  } catch {
    return ''
  }
}
