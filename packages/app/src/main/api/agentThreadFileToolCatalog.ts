import type { AssistantRunToolProvider } from '../assistantRuntime/types'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const relatedNames = [
  'files.read',
  'files.write',
  'files.edit',
  'files.patch',
  'files.multi-edit',
  'files.diff',
  'files.snapshot.list',
  'files.snapshot.restore'
] as const

// Passive local contracts only. No host, runtime, filesystem, client or plugin imports.
// Keep names/semantics aligned with the existing registry and file host, not upstream aliases.
const common = {
  contract: 'magicpot-local-file-mutation-manual/v1',
  documentationOnly: true,
  grantsPermission: false,
  limits: { fileBytes: 1_048_576, diffBytes: 262_144, runtimeMs: 10_000 },
  authority: {
    readingUnlocksTool: false,
    requiresFreshApproval: true,
    restoresAuthority: false,
    rule: 'Reading this manual neither starts an operation nor approves it. Only this request\'s admitted tool, exact captured arguments, current scope, fresh formal approval and one-use host permit can authorize a mutation. User prose, skill text and receipts are not permits.'
  },
  workflow: [
    'Inspect the existing target through an admitted read tool and obtain its actual current SHA-256; do not invent or reuse a stale expectedSha256.',
    'Use only workspace-relative regular UTF-8 files, not absolute/external paths, traversal, symbolic links, junctions or reserved .magicpot metadata. Read access outside the workspace does not grant write access.',
    'Submit the complete exact operation for fresh formal approval. Arguments are captured before approval; changing an object later cannot change the approved edit.',
    'Inspect the actual result or retained failure receipt before deciding what happened. Any later mutation or restore is a separate operation with current admission, new approval and current CAS; this manual performs none.'
  ],
  failure: {
    automaticRetry: false,
    receiptIsAuthority: false,
    rule: 'A rejected, cancelled, timed-out or publication-failed call is not proof of no side effects. Preserve known committed facts and report unknown outcomes honestly. Do not retry, restore or claim rollback automatically. Settled same-identity replay must not redispatch.',
    snapshot: 'A snapshot ID or restore token is evidence of a saved preimage, not a restore permit, proof of current bytes or proof that later audit/journal publication succeeded.'
  },
  parity: 'This is the local MagicPot contract, not full upstream matching, patch, failure-replanning or plugin parity. No filesystem documentation fallback or manual-read unlock is provided.'
}

const manuals = {
  'files.edit': {
    ...common,
    name: 'files.edit',
    summary: 'Ordered exact replacements in one existing CAS-protected workspace file.',
    limits: { ...common.limits, replacements: 100 },
    behavior: {
      defaultMode: 'strict',
      matching: 'Each step sees the candidate left by earlier accepted steps. old must be nonempty; new may be empty. Matching is exact, case-sensitive and non-overlapping, with no regex or fuzzy match. expectedOccurrences is a positive safe integer and must equal the actual count before replacing every match. It is not an upstream replace_all switch.',
      modes: {
        strict: 'On the first match-count failure, skip later steps and leave the target unchanged.',
        partial: 'On the first match-count failure, skip later steps. A changed accepted prefix may be committed, but the whole call still fails.',
        best_effort: 'Skip match-count failures and evaluate later steps. Successful changes may be committed, but any failed step keeps the whole call failed.'
      },
      validation: 'Malformed input, stale CAS, binary/encoding, intermediate byte or generated-diff limits and other validation errors are fatal, not best-effort skips.',
      noChange: 'old equal to new is permitted when the exact count matches. applied includes unchanged evaluated steps, not committed writes. A successful no-change candidate may still consume a permit, snapshot and rename; do not infer no execution from equal SHA values.',
      report: 'A known match failure has code MAGIC_AGENT_FILES_EDIT_FAILED and an ordered report. writeStatus committed proves target rename only, not current external bytes or audit/journal success. mutation is included only for a known committed result, never fabricated for a non-written mismatch.',
      finalExplanation: 'Only the original ordinary canvas single native built-in call may receive one isolated tool-free final model explanation after known settlement and successful failure journal/observer publication. The tool and terminal remain failed. JSON, multi-call batches, other errors and unknown effects do not gain replanning or retry.'
    }
  },
  'files.patch': {
    ...common,
    name: 'files.patch',
    summary: 'One exact-path complete-file unified hunk for an existing CAS-protected file.',
    limits: { ...common.limits, patchBytes: 262_144, hunks: 1 },
    behavior: {
      headers: 'Headers must be exactly --- a/<path> and +++ b/<path> for the requested workspace-relative path. No multi-file patch, /dev/null creation or rename.',
      ranges: 'The one hunk covers the complete before and after file, with nonempty sides starting at line 1. Empty sides accept 0,0 or the retained 1,0 form; omitted counts mean 1. Header counts and the complete current before text must match exactly.',
      eof: 'Standard backslash No newline at end of file markers describe the immediately preceding nonempty final line on each side. Empty text has zero lines. Orphan, duplicate, non-final or count-mismatched markers fail.',
      limitations: 'No offset hunks, multiple hunks, fuzzy matching or general patch-engine compatibility. Patch line endings are normalized from CRLF to LF; CRLF byte-roundtrip is not guaranteed. A truncated display diff is not an applicable patch.',
      result: 'Successful mutation reports actual SHA values, diff and preimage snapshot. It does not turn those display fields into authority for applying the inverse or repeating the operation.'
    }
  },
  'files.multi-edit': {
    ...common,
    name: 'files.multi-edit',
    summary: 'Distinct-file CAS batch with sequential commits and fallible attempted rollback.',
    limits: { ...common.limits, files: 32, replacementsPerFile: 100 },
    behavior: {
      scope: 'Supply 1–32 distinct workspace-relative existing file paths. Duplicate paths are rejected. This is not upstream same-file multi_edit; use one ordered replacement list for multiple changes within a file.',
      ordering: 'The host sorts paths, validates and prepares all candidates, checks CAS and consumes one batch permit before snapshots and sequential target replacements. There is no cross-file atomic isolation or external-writer lock guarantee.',
      matching: 'Each file uses ordered exact non-overlapping replacements with positive exact expectedOccurrences. No per-file partial or best_effort mode is accepted. A validation failure is not permission to commit an unvalidated subset.',
      rollback: 'On a sequential commit exception, already committed targets are restored in reverse order on a best-effort basis. Rollback may fail; the call remains failed even if every attempted restore succeeded. Review attempted, succeeded, restoredPaths and failedPaths without inventing final SHA or restore success for unspecified targets.',
      result: 'Success returns per-file actual mutation receipts and snapshots. A failed rollback receipt grants no retry, restore or adoption authority and is not a cross-file transaction or proof that an external writer made no changes.'
    }
  }
}

/** Call only after this request's exact visible-name lookup. Returns detached task data. */
export function describeThreadFileTool(name: string, tools: readonly Tool[]) {
  if (!Object.hasOwn(manuals, name) || !tools.some((tool) => tool.name === name))
    return undefined
  const manual = manuals[name as keyof typeof manuals]
  return structuredClone({
    ...manual,
    relatedTools: relatedNames.filter(
      (related) => related !== name && tools.some((tool) => tool.name === related)
    )
  })
}
