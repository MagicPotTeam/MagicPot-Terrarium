/**
 * Test-only stand-in for MAIN's report-bundle registry (svcReportBundles.verify).
 *
 * `register` plays the part of MAIN sealing a bundle that the canvas wrote for one
 * conversation: it returns a copy of the primary report descriptor carrying a fresh binding.
 * `verify` answers 'verified' only for the exact (binding, conversationId, primaryUrl) triple
 * that `register` issued, with the manifest URL and image count MAIN would return, and
 * 'refused' for everything else. Unlike MAIN it does not look at files, so a fixture may
 * register a primary URL (for example blob:) that production MAIN would never verify.
 */
import { vi } from 'vitest'
import type {
  VerifyReportBundleResult,
  VerifyReportBundlesReq,
  VerifyReportBundlesResp
} from '@shared/api/svcReportBundles'

type PrimaryReportDescriptor = {
  url: string
  reportBundleManifestUrl?: string
  reportBundleImageCount?: number
}

type RegisteredFixture = {
  conversationId: string
  primaryUrl: string
  manifestUrl?: string
  imageCount: number
}

export type RegisterReportBundleFixtureOptions = {
  /** MAIN's manifest URL; defaults to the descriptor's own, `null` for none. */
  manifestUrl?: string | null
  /** MAIN's image count; defaults to the descriptor's hint, or 0. */
  imageCount?: number
}

const newBinding = (): string => {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  const base64 = btoa(String.fromCharCode(...bytes))
  return `rb1.${base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

export function createReportBundleRegistryFixture() {
  const registered = new Map<string, RegisteredFixture>()

  const register = <T extends PrimaryReportDescriptor>(
    primary: T,
    conversationId: string,
    options: RegisterReportBundleFixtureOptions = {}
  ): T & { reportBundleBinding: string } => {
    const binding = newBinding()
    const manifestUrl =
      options.manifestUrl === null
        ? undefined
        : (options.manifestUrl ?? primary.reportBundleManifestUrl)
    registered.set(binding, {
      conversationId,
      primaryUrl: primary.url,
      ...(manifestUrl ? { manifestUrl } : {}),
      imageCount: options.imageCount ?? primary.reportBundleImageCount ?? 0
    })
    return { ...primary, reportBundleBinding: binding }
  }

  const verify = vi.fn(async (req: VerifyReportBundlesReq): Promise<VerifyReportBundlesResp> => ({
    results: req.items.map((item): VerifyReportBundleResult => {
      const record = registered.get(item.binding)
      if (
        !record ||
        record.conversationId !== req.conversation?.conversationId ||
        record.primaryUrl !== item.primaryUrl
      ) {
        return { binding: item.binding, status: 'refused' }
      }
      return {
        binding: item.binding,
        status: 'verified',
        ...(record.manifestUrl ? { manifestUrl: record.manifestUrl } : {}),
        imageCount: record.imageCount
      }
    })
  }))

  return { register, verify, svcReportBundles: { verify } }
}
