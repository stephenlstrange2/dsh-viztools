import { describe, expect, it } from 'vitest'
import { parseSidebarStatus } from '../src/client.js'

describe('secure sidebar payload', () => {
  it('accepts only the complete Host response', () => {
    expect(parseSidebarStatus({
      browserUrl: 'http://127.0.0.1:4321/?access_token=secret',
      notebook: '/workspace/.dsh/notebooks/explanation.py',
      marimoVersion: '0.25.1',
    })).toEqual({
      browserUrl: 'http://127.0.0.1:4321/?access_token=secret',
      notebook: '/workspace/.dsh/notebooks/explanation.py',
      marimoVersion: '0.25.1',
    })
  })

  it('rejects incomplete or malformed responses', () => {
    expect(parseSidebarStatus({ browserUrl: 'x' })).toBeUndefined()
    expect(parseSidebarStatus(null)).toBeUndefined()
  })
})
