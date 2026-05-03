// BKL-ARCH-23: pipeline signal source.

import { describe, it, expect } from 'bun:test'
import { pipelineSource } from '../../../../src/customer/signals/pipeline.ts'
import { makeCtx } from './_helpers.ts'
import type { PipelineRecord } from '../../../../src/pipeline.ts'
import type { Customer } from '../../../../src/types.ts'

const customer: Customer = { name: 'Acme' }

describe('pipelineSource', () => {
  it('collect returns null when pipeline empty', async () => {
    expect(await pipelineSource.collect({ customer, pipeline: [] })).toBeNull()
  })

  it('render emits opp name, stage, amount, close date in legacy format', () => {
    const items = [
      { oppName: 'Big Deal', forecastCategory: 'Commit', acv: 100000, closeDate: '2026-06-30' } as unknown as PipelineRecord,
    ]
    const xml = pipelineSource.render(
      { kind: 'pipeline', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items },
      makeCtx(),
    )
    expect(xml).toContain('<source type="pipeline" synced="2026-05-02" count="1">')
    expect(xml).toContain('Big Deal | stage: Commit | amount: $100000 | close: 2026-06-30')
    expect(xml.endsWith('</source>')).toBe(true)
  })
})
