import { describe, expect, it } from 'vitest'
import {
  UNVERIFIED_REPORT_BUNDLE_MESSAGE,
  assertNoUnverifiedPrimaryReports,
  hasWellFormedReportBundleBinding,
  isPrimaryReportFileDescriptor,
  isUnavailablePrimaryReportFile
} from './unverifiedReport'

const valid = `rb1.${'Ab0_-'.repeat(8)}xyz`

describe('report-bundle binding shape', () => {
  it.each([
    ['43 base64url characters', valid, true],
    ['all letters', `rb1.${'a'.repeat(43)}`, true],
    ['missing', undefined, false],
    ['empty', '', false],
    ['one character short', `rb1.${'a'.repeat(42)}`, false],
    ['one character long', `rb1.${'a'.repeat(44)}`, false],
    ['wrong prefix', `rb2.${'a'.repeat(43)}`, false],
    ['ticket prefix', `rbt1.${'a'.repeat(43)}`, false],
    ['no prefix', 'a'.repeat(47), false],
    ['standard base64 plus', `rb1.${'a'.repeat(42)}+`, false],
    ['standard base64 slash', `rb1.${'a'.repeat(42)}/`, false],
    ['padding', `rb1.${'a'.repeat(42)}=`, false],
    ['leading space', ` ${valid}`, false],
    ['trailing newline', `${valid}\n`, false],
    ['not a string', 42 as unknown as string, false]
  ])('%s', (_name, binding, expected) => {
    expect(hasWellFormedReportBundleBinding({ type: 'file', reportBundleBinding: binding })).toBe(
      expected
    )
  })
})

describe('assertNoUnverifiedPrimaryReports', () => {
  const primary = (binding?: string) => ({
    type: 'file',
    reportBundleRole: 'primary-report',
    ...(binding !== undefined ? { reportBundleBinding: binding } : {})
  })

  it('refuses a primary report file without a well-formed binding, in any role', () => {
    for (const attachment of [primary(), primary(''), primary(`rb1.${'a'.repeat(42)}`)]) {
      expect(() => assertNoUnverifiedPrimaryReports([{ attachments: [attachment] }])).toThrow(
        UNVERIFIED_REPORT_BUNDLE_MESSAGE
      )
      expect(() =>
        assertNoUnverifiedPrimaryReports([
          { attachments: [] },
          { attachments: [primary(valid), attachment] }
        ])
      ).toThrow(UNVERIFIED_REPORT_BUNDLE_MESSAGE)
    }
  })

  it('passes a well-formed binding to the authoritative check, and leaves other files alone', () => {
    expect(() =>
      assertNoUnverifiedPrimaryReports([{ attachments: [primary(valid)] }])
    ).not.toThrow()
    expect(() =>
      assertNoUnverifiedPrimaryReports([
        { attachments: [{ type: 'file' }, { type: 'image', reportBundleRole: 'primary-report' }] },
        {}
      ])
    ).not.toThrow()
  })

  it('names only file attachments with the primary-report role as primary reports', () => {
    expect(
      isPrimaryReportFileDescriptor({ type: 'file', reportBundleRole: 'primary-report' })
    ).toBe(true)
    expect(
      isPrimaryReportFileDescriptor({ type: 'image', reportBundleRole: 'primary-report' })
    ).toBe(false)
    expect(isPrimaryReportFileDescriptor({ type: 'file', reportBundleRole: 'report-image' })).toBe(
      false
    )
  })
})

describe('isUnavailablePrimaryReportFile', () => {
  it('marks only primary report files without a well-formed binding', () => {
    const primary = { type: 'file', reportBundleRole: 'primary-report' }
    expect(isUnavailablePrimaryReportFile(primary)).toBe(true)
    expect(isUnavailablePrimaryReportFile({ ...primary, reportBundleBinding: '' })).toBe(true)
    expect(
      isUnavailablePrimaryReportFile({ ...primary, reportBundleBinding: `rb1.${'a'.repeat(42)}` })
    ).toBe(true)
    expect(isUnavailablePrimaryReportFile({ ...primary, reportBundleBinding: valid })).toBe(false)
    expect(isUnavailablePrimaryReportFile({ type: 'file' })).toBe(false)
    expect(isUnavailablePrimaryReportFile({ type: 'file', reportBundleRole: 'report-image' })).toBe(
      false
    )
    expect(
      isUnavailablePrimaryReportFile({ type: 'image', reportBundleRole: 'primary-report' })
    ).toBe(false)
  })
})
