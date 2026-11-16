import { describe, expect, it } from 'vitest'
import { ServiceValidationError } from './apiUtils/serviceValidation'
import {
  reportBundlesSvcDef,
  validateBeginReportBundleReq,
  validateBeginReportBundleResp,
  validateRegisterReportBundleReq,
  validateRegisterReportBundleResp,
  validateVerifyReportBundlesReq,
  validateVerifyReportBundlesResp
} from './svcReportBundles'
import { isReportBundleBinding, isReportBundleTicket } from '../reportBundle'

const binding = `rb1.${'A'.repeat(42)}w`
const ticket = `rbt1.${'b'.repeat(43)}`
const conversation = { conversationId: 'conv-1', storageScope: 'project.pane' }

describe('svcReportBundles contract', () => {
  it('declares three unary methods with explicit validators', () => {
    for (const method of ['beginBundle', 'register', 'verify'] as const) {
      expect(reportBundlesSvcDef[method].type).toBe('unary')
      expect(typeof reportBundlesSvcDef[method].request).toBe('function')
      expect(typeof reportBundlesSvcDef[method].response).toBe('function')
    }
  })

  it('recognises bindings and tickets only in their exact form', () => {
    expect(isReportBundleBinding(binding)).toBe(true)
    expect(isReportBundleBinding(`${binding}x`)).toBe(false)
    expect(isReportBundleBinding(`rb2.${'A'.repeat(43)}`)).toBe(false)
    expect(isReportBundleBinding(`rb1.${'A'.repeat(42)}=`)).toBe(false)
    expect(isReportBundleBinding(ticket)).toBe(false)
    expect(isReportBundleTicket(ticket)).toBe(true)
    expect(isReportBundleTicket(binding)).toBe(false)
  })

  it('accepts a well-formed beginBundle request and drops nothing it needs', () => {
    expect(
      validateBeginReportBundleReq({ bundleDir: '/data/.report_bundles/b', conversation })
    ).toEqual({
      bundleDir: '/data/.report_bundles/b',
      conversation
    })
    expect(
      validateBeginReportBundleReq({
        bundleDir: 'C:/data/.report_bundles/b',
        conversation: { conversationId: 'c' }
      })
    ).toEqual({ bundleDir: 'C:/data/.report_bundles/b', conversation: { conversationId: 'c' } })
  })

  it.each([
    ['missing conversation', { bundleDir: '/x' }],
    ['extra key', { bundleDir: '/x', conversation, root: '/elsewhere' }],
    ['empty dir', { bundleDir: '', conversation }],
    ['NUL in dir', { bundleDir: '/x\0y', conversation }],
    ['overlong dir', { bundleDir: `/${'a'.repeat(5000)}`, conversation }],
    ['empty conversation id', { bundleDir: '/x', conversation: { conversationId: '' } }],
    ['numeric conversation id', { bundleDir: '/x', conversation: { conversationId: 1 } }],
    [
      'overlong conversation id',
      { bundleDir: '/x', conversation: { conversationId: 'c'.repeat(257) } }
    ],
    [
      'bad storage scope',
      { bundleDir: '/x', conversation: { conversationId: 'c', storageScope: 'a\nb' } }
    ],
    ['extra conversation key', { bundleDir: '/x', conversation: { ...conversation, extra: 1 } }],
    ['not an object', null]
  ])('refuses a beginBundle request with %s', (_label, request) => {
    expect(() => validateBeginReportBundleReq(request)).toThrow(ServiceValidationError)
  })

  it('validates tickets and register responses', () => {
    expect(validateRegisterReportBundleReq({ ticket })).toEqual({ ticket })
    expect(() => validateRegisterReportBundleReq({ ticket: binding })).toThrow(
      ServiceValidationError
    )
    expect(() => validateRegisterReportBundleReq({})).toThrow(ServiceValidationError)
    expect(validateBeginReportBundleResp({ ticket })).toEqual({ ticket })
    expect(() => validateBeginReportBundleResp({ ticket: 'x' })).toThrow(ServiceValidationError)
    const resp = { binding, bundleId: 'canvas-target-1', imageCount: 2, omittedEntries: 1 }
    expect(validateRegisterReportBundleResp(resp)).toEqual(resp)
    expect(() => validateRegisterReportBundleResp({ ...resp, binding: 'rb1.short' })).toThrow(
      ServiceValidationError
    )
    expect(() => validateRegisterReportBundleResp({ ...resp, imageCount: -1 })).toThrow(
      ServiceValidationError
    )
  })

  it('accepts at most 64 verify items with well-formed bindings and bounded URLs', () => {
    const item = { binding, primaryUrl: 'local-media:///data/r.md' }
    expect(validateVerifyReportBundlesReq({ conversation, items: [item] })).toEqual({
      conversation,
      items: [item]
    })
    expect(
      validateVerifyReportBundlesReq({ conversation, items: Array(64).fill(item) }).items
    ).toHaveLength(64)
    expect(() =>
      validateVerifyReportBundlesReq({ conversation, items: Array(65).fill(item) })
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateVerifyReportBundlesReq({ conversation, items: [{ ...item, binding: 'rb1.x' }] })
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateVerifyReportBundlesReq({
        conversation,
        items: [{ ...item, primaryUrl: `local-media:///${'a'.repeat(20000)}` }]
      })
    ).toThrow(ServiceValidationError)
    expect(() => validateVerifyReportBundlesReq({ items: [item] })).toThrow(ServiceValidationError)
    expect(() =>
      validateVerifyReportBundlesReq({ conversation, items: [{ ...item, extra: true }] })
    ).toThrow(ServiceValidationError)
  })

  it('validates verify responses strictly', () => {
    const verified = {
      binding,
      status: 'verified',
      manifestUrl: 'local-media:///u/report-bundles/x/manifest.json',
      imageCount: 3
    }
    const refused = { binding, status: 'refused' }
    expect(validateVerifyReportBundlesResp({ results: [verified, refused] })).toEqual({
      results: [verified, refused]
    })
    for (const bad of [
      { ...verified, status: 'unknown' },
      { ...verified, manifestUrl: 'https://example.test/m.json' },
      { binding, status: 'verified' },
      { ...refused, manifestUrl: verified.manifestUrl },
      { ...verified, binding: 'rb1.x' }
    ]) {
      expect(() => validateVerifyReportBundlesResp({ results: [bad] })).toThrow(
        ServiceValidationError
      )
    }
  })
})
