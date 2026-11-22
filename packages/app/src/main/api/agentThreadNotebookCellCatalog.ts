import type { AssistantRunToolProvider } from '../assistantRuntime/types'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const relatedNames = ['notebook.browse', 'notebook.inspect', 'notebook.cell.insert', 'notebook.cell.replace', 'notebook.cell.delete', 'notebook.cell.convert', 'notebook.cell.clear-outputs', 'notebook.run', 'info'] as const

// Static passive facts only. No filesystem, Notebook host, approval, process manager or interpreter import.
const common = {
  contract: 'magicpot-local-notebook-cell-mutation-manual/v1', documentationOnly: true, grantsPermission: false,
  authority: {
    readingUnlocksTool: false, requiresMutationOptIn: true, requiresInterpreter: false,
    requiresFreshFormalApproval: true, shaIsPermission: false,
    rule: 'Only an exact currently admitted cell-mutation tool is described. Separate actual calls still require the MAIN-owned live thread/document/conversation/workspace, local transport and enable_agent_python_notebook, current settings/ownership/cancellation checks, original read and write policy, a fresh exact one-use formal approval, current expectedSha256 CAS, shared operation/notebook locks and unknown-stop quarantine. A manual, earlier notebook read, cell ID, hash, snapshot or conversation answer is never an approval or a read-unlock capability. Cell mutations do not execute code or require a configured Python interpreter/provenance probe; that does not bypass write approval.'
  },
  limits: {
    pathSchemaCharacters: 2048, sharedScriptCallsPerRequest: 12, sharedEffectfulCallsPerRequest: 4,
    sourceSchemaCharacters: 262144, sourceHostUtf8BytesPerCell: 1048576, maximumCellIds: 256,
    notebookBytes: 8388608, notebookCells: 1000, maximumStableIdCharacters: 64
  },
  workflow: [
    'Read the exact current tool schema and this passive manual. Info opens no notebook or generation/snapshot, calls no filesystem/read policy/host/manager/interpreter, spends no script/effectful/execution budget, requests no approval and adds no timer/IPC or mutation authority.',
    'For a separately intended mutation, inspect the existing workspace notebook and exact stable IDs, obtain its current full-byte SHA, then submit only this tool\'s bounded exact inputs and expectedSha256. Inspection/hash knowledge is not permission; an invalid/stale document, unavailable tool or cancelled owner must still reject.',
    'The actual host reads and checks current SHA before requesting fresh formal write approval for the exact detached operation/path/source/IDs/SHA. It may create the validated snapshot directory and persist read/audit data before approval. Denial is not a universal no-effects or metadata-cleanup guarantee, although no write is authorized by the manual.',
    'After approval the host checks live ownership/settings/quarantine, authorizes the exact input, edits a cloned fully validated document, rechecks SHA and consumes the one-use permit before writing a content-addressed backup and the replacement. Do not reuse a receipt/permit or infer that a queued approval or hash authorizes another operation.',
    'Use actual returned before/after hashes and IDs as bounded evidence; verify independently if required. Stop, cancellation, CAS conflict or later persistence failure is not automatic retry/rollback authority. A failure after rename or a late live check can occur after bytes changed; retain uncertainty rather than claiming success, no mutation or a fresh execution.'
  ],
  behavior: {
    paths: 'path is a workspace-relative string of 1–2048 schema characters to an existing single-link regular .ipynb file. Absolute/NUL/traversal/reserved .magicpot paths and linked escapes are rejected. Full strict UTF-8 JSON nbformat-v4 validation with unique real stable [A-Za-z0-9_-]{1,64} IDs occurs before and after editing. No notebook creation, synthetic cell-N IDs, case-folded cell matching, ID migration, external path or arbitrary-file fallback is provided.',
    bounds: 'The existing document and serialized result must fit 8 MiB and 1000 cells. Thread source inputs are strings of at most 262144 schema characters (empty source is allowed); the host separately enforces 1 MiB UTF-8 per cell, including existing source. The thread accepts no source array, metadata/attachments/output body or arbitrary notebook JSON fields. ID arrays are nonempty, distinct and at most256. Host metadata/output/depth/MIME validation remains in force; display truncation cannot make an oversized document writable.',
    budgets: 'Actual cell mutations consume one of the original twelve total script calls and four effectful attempts shared with Python/Notebook operations in this request; they do not consume the two execution attempts. Valid calls that later fail do not refund those attempt budgets. Info spends none. Captured admission plus current opt-in, route/workspace/owner/read/write policy and cancellation still apply; reading never unlocks an initially hidden or now-disabled operation.',
    commit: 'Each tool is one operation on one notebook. Selected IDs are all resolved/validated on a clone before a single commit; there is no ordered edits array, partial/best_effort mode, multi-file transaction or automatic rollback. Serialization sorts JSON object keys and appends a newline, so even a logical no-op can change bytes, request approval, consume a permit, create a backup and replace the file. Repeated SHA checks do not eliminate every external filesystem race or provide a cross-process lock.',
    backup: 'The original full notebook is backed up as .magicpot/notebook-snapshots/<beforeSHA>.ipynb after permit consumption and before target replacement; an existing backup is hash-checked. Snapshot data is not a restored permission, rollback, secret store or erasure guarantee. A later failure can leave directories, backup/source/history/audit data. No snapshot-restore tool or automatic retry is added.',
    result: 'Successful return is {executionMode:"stateless",kernelPersistent:false,root,path,beforeSha256,afterSha256,cellIds,cellCount,snapshotId}. root is the canonical absolute owned workspace; hashes describe bytes and snapshotId identifies original data. No top-level state/status/writeStatus/mutation/businessTaskVerified/untrustedData marker, execution receipt, changed flag or generation increment is supplied by these operations. This is a cell-file mutation, not code execution, output verification or business correctness.',
    parity: 'These five local exact tools are not notebook_edit aliases. No upstream cell_id/new_source/edit_mode/insert_location/clear_outputs spellings, edits batch, strict/partial/best_effort switches, read-unlock protocol, synthetic indices, preserve-code-output flag, persistent kernel, model-supplied approval or notebook.run behavior is added.'
  },
  failure: {
    automaticRetry: false, cancellationRollsBack: false, failureProvesNoMutation: false,
    rule: 'Stale SHA, invalid or duplicate IDs, missing anchor, invalid result, revoked owner/configuration, approval denial/cancellation and read/write policy failure reject. The permit is consumed before backup; temp-file/sync/chmod/live checks and rename are fallible. A rename may already have replaced bytes when later directory sync/close/audit persistence or provider post-return live checks fail. No automatic rollback or general no-effects guarantee follows from rejection/cancellation. Keep ambiguous outcomes distinct from success and do not replay a prior receipt as authority.'
  }
}
const manuals = {
  'notebook.cell.insert': {
    ...common, name: 'notebook.cell.insert', summary: 'Insert one bounded cell into an existing workspace notebook after fresh exact approval and SHA CAS; never executes source.',
    mutation: {
      operation: 'insert',
      input: 'Required path, expectedSha256 (64 lowercase hexadecimal characters), cell:{cellType,source}, and explicit position:begin|end|before|after. Optional cell.id is a real unique stable ID; if omitted the host generates a16-hex-character ID. before/after requires an exact referenceCellId at host validation; begin/end ignore a supplied referenceCellId rather than using it as a selector. No implicit after/default position or metadata/source-array field is accepted.',
      effect: 'Inserts one normalized source cell at the selected position. New metadata is empty; new code cells start with outputs:[] and execution_count:null. Existing cells/IDs remain subject to whole-document validation. Duplicate IDs or exceeding the1000-cell/result bound reject before target replacement; no source is run.'
    }
  },
  'notebook.cell.replace': {
    ...common, name: 'notebook.cell.replace', summary: 'Replace one exact cell source/type under fresh approval and SHA CAS, always clearing resulting code outputs.',
    mutation: {
      operation: 'replace',
      input: 'Required path, expectedSha256, exact cellId and source string; optional cellType:code|markdown|raw. Empty source is legal but source may not be omitted. No caller metadata, clearOutputs/clear_outputs:false, output preservation, cellIds array or batch is accepted. The app forces clearOutputs:true in both the exact approved payload and actual host call.',
      effect: 'Replaces source, optionally changes type and preserves the real ID and other permitted existing metadata/attachments subject to full validation. Resulting code cells always have outputs:[] and execution_count:null, even if source/type was logically unchanged. Changing to noncode removes execution_count/outputs. This does not execute the replacement or retain stale code outputs.'
    }
  },
  'notebook.cell.delete': {
    ...common, name: 'notebook.cell.delete', summary: 'Delete a distinct bounded set of exact existing cell IDs in one approved SHA-CAS mutation.',
    mutation: {
      operation: 'delete',
      input: 'Required path, expectedSha256 and cellIds:1–256 distinct exact real stored IDs. Every ID must resolve; no index, synthetic positional ID, implicit all-cells, partial mode or singular cellId alias.',
      effect: 'Resolves the entire ID set before removing selected cells from the cloned document in one file commit. Unselected order and IDs are retained. A missing ID rejects the operation rather than deleting the found subset. Deleting all existing cells is allowed by the bounded v4 format but still requires fresh exact approval and SHA CAS.'
    }
  },
  'notebook.cell.convert': {
    ...common, name: 'notebook.cell.convert', summary: 'Convert exact cells to code/markdown/raw in one approved mutation, resetting code execution fields even for same-type code.',
    mutation: {
      operation: 'convert',
      input: 'Required path, expectedSha256, cellIds:1–256 distinct exact stored IDs and cellType:code|markdown|raw. No new source, metadata, outputs, preserve-output flag, singular cellId or execution options.',
      effect: 'Runs conversion for every selected cell, including code→code: resulting code gets outputs:[] and execution_count:null. Noncode results remove those fields. Source, real ID and other permitted existing metadata/attachments are retained and revalidated. A same-type request is not necessarily a no-op and never executes or validates the source as a program.'
    }
  },
  'notebook.cell.clear-outputs': {
    ...common, name: 'notebook.cell.clear-outputs', summary: 'Clear stored code-cell outputs/execution counts for exact IDs under independent approval and SHA CAS.',
    mutation: {
      operation: 'clear-outputs',
      input: 'Required path, expectedSha256 and cellIds:1–256 distinct exact existing IDs. No implicit all, singular cellId, source/type/metadata/output body, run/generation or approval aliases.',
      effect: 'For selected code cells sets outputs:[] and execution_count:null; selected noncode cells have no logical change. It still follows full approval/validation/serialization/permit/backup/replacement/audit and may rewrite canonical bytes. Source, IDs and permitted metadata remain. Clearing saved output does not erase snapshots/history/logs, stop a task, undo code effects or prove that outputs were safe/current.'
    }
  }
}

/** Exact current-visible name plus independent own catalog membership, then clone every returned field. */
export function describeThreadNotebookCellMutation(name: string, tools: readonly Tool[]) {
  if (!Object.hasOwn(manuals, name) || !tools.some(tool => tool.name === name)) return undefined
  return structuredClone({ ...manuals[name as keyof typeof manuals], relatedTools: relatedNames.filter(related => related !== name && tools.some(tool => tool.name === related)) })
}
