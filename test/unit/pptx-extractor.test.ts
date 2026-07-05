import { describe, it, expect } from 'bun:test'

describe('pptx-extractor', () => {
  it('extracts text from PPTX slide XML', async () => {
    const { extractPptxText } = await import('../../src/lib/pptx-extractor')

    // Build a minimal PPTX (ZIP) with one slide containing text
    const { zipSync } = await import('fflate')

    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>Hello World</a:t></a:r></a:p>
          <a:p><a:r><a:t>Second paragraph</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>Another shape</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`

    const pptxBuffer = zipSync({
      'ppt/slides/slide1.xml': new TextEncoder().encode(slideXml),
      '[Content_Types].xml': new TextEncoder().encode('<?xml version="1.0"?><Types></Types>'),
    })

    const text = extractPptxText(Buffer.from(pptxBuffer))
    expect(text).toContain('Hello World')
    expect(text).toContain('Second paragraph')
    expect(text).toContain('Another shape')
    // Must NOT contain XML tags
    expect(text).not.toContain('<a:t>')
    expect(text).not.toContain('<a:r>')
    expect(text).not.toContain('</p:sld>')
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('handles multiple slides in order', async () => {
    const { extractPptxText } = await import('../../src/lib/pptx-extractor')
    const { zipSync } = await import('fflate')

    const slide1 = `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Slide 1 content</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`

    const slide2 = `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Slide 2 content</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`

    const pptxBuffer = zipSync({
      'ppt/slides/slide1.xml': new TextEncoder().encode(slide1),
      'ppt/slides/slide2.xml': new TextEncoder().encode(slide2),
      '[Content_Types].xml': new TextEncoder().encode('<?xml version="1.0"?><Types></Types>'),
    })

    const text = extractPptxText(Buffer.from(pptxBuffer))
    const idx1 = text.indexOf('Slide 1 content')
    const idx2 = text.indexOf('Slide 2 content')
    expect(idx1).toBeGreaterThanOrEqual(0)
    expect(idx2).toBeGreaterThan(idx1)
  })

  it('returns empty string for PPTX with no slides', async () => {
    const { extractPptxText } = await import('../../src/lib/pptx-extractor')
    const { zipSync } = await import('fflate')

    const pptxBuffer = zipSync({
      '[Content_Types].xml': new TextEncoder().encode('<?xml version="1.0"?><Types></Types>'),
    })

    const text = extractPptxText(Buffer.from(pptxBuffer))
    expect(text).toBe('')
  })

  it('returns empty string for corrupt/invalid buffer', async () => {
    const { extractPptxText } = await import('../../src/lib/pptx-extractor')
    const text = extractPptxText(Buffer.from('not a zip file'))
    expect(text).toBe('')
  })
})
