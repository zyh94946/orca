import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { withSpan } from '../observability/tracer'
import { sessionSortTime } from './session-scanner-accumulator'
import { ScannedSessionCollection, dedupeScannedSessions } from './session-root-dedup'
import {
  createAntigravityWorkspaceResolver,
  readLocalAntigravityHistory,
  type AntigravityWorkspaceResolver
} from './session-scanner-antigravity-history'
import { sessionCandidatesFromDiscoveries } from './session-scanner-candidates'
import {
  createSessionParseStats,
  parseListedSessionFile,
  type SessionParseStats
} from './session-scanner-parse-cache'
import { recordSessionScanIssue } from './session-scan-issues'
import { aiVaultScanWorkload, noteAiVaultScanReading } from './ai-vault-scan-progress'
import { yieldScanInventory } from './session-scanner-scope-inventory'
import { prepareScopeScan, scanInScopeSessions } from './session-scanner-scope-walk'
import { discoverAiVaultSessionSources } from './session-scanner-source-discovery'
import { cursorChatMetaRefusals, withCursorChatMetaScan } from './session-scanner-cursor-chat-meta'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery,
  SessionParseResult
} from './session-scanner-types'
import { clampPositiveInteger, errorMessage } from './session-scanner-values'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { DEFAULT_AI_VAULT_SCAN_LIMIT } from '../../shared/ai-vault-session-depth'
import { withDevinSessionsDbScan } from './session-scanner-devin-db'
import { isConversationNameRequestSession } from './conversation-name-request-sessions'
import { withOpenCodeSqliteScanScope } from './session-scanner-opencode-sqlite-scan-scope'

const SESSION_PARSE_CONCURRENCY = 8
const SESSION_PARSE_CANDIDATE_MULTIPLIER = 2

/** Return recency-capped sessions plus recovered in-scope sessions, deduplicated and sorted. */
export async function scanAiVaultSessions(
  options: AiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  return withOpenCodeSqliteScanScope(() => scanAiVaultSessionStores(options))
}

async function scanAiVaultSessionStores(options: AiVaultScanOptions): Promise<AiVaultListResult> {
  // Keep Cursor metadata scoped across discovery and parsing to read the chats tree only once.
  return withSpan('aiVault.scan', (span) =>
    withDevinSessionsDbScan(() =>
      withCursorChatMetaScan(async () => {
        const limit = options.unlimited
          ? Number.POSITIVE_INFINITY
          : clampPositiveInteger(options.limit, DEFAULT_AI_VAULT_SCAN_LIMIT)
        const limitPerAgent = options.unlimited
          ? Number.POSITIVE_INFINITY
          : clampPositiveInteger(options.limitPerAgent, limit * SESSION_PARSE_CANDIDATE_MULTIPLIER)
        const platform = options.platform ?? process.platform
        const executionHostId = options.executionHostId ?? LOCAL_EXECUTION_HOST_ID
        const issues: AiVaultScanIssue[] = []
        const parseStats = createSessionParseStats()
        const antigravityWorkspaceResolver = createAntigravityWorkspaceResolver((path) =>
          readLocalAntigravityHistory(path, options.signal)
        )
        throwIfAiVaultScanCancelled(options.signal)
        const discoveries = await discoverAiVaultSessionSources({
          options,
          limitPerAgent,
          issues
        })
        throwIfAiVaultScanCancelled(options.signal)

        const candidates = await sessionCandidatesFromDiscoveries(discoveries, options)
        const parseCandidates = candidates.slice(0, limit * SESSION_PARSE_CANDIDATE_MULTIPLIER)

        const workload = aiVaultScanWorkload(options.signal)
        if (workload) {
          for (const [index, candidate] of parseCandidates.entries()) {
            await yieldScanInventory(index, options.signal)
            workload.register(candidate, 'global')
          }
        }
        const inventory = await prepareScopeScan({ discoveries, options, limit })
        throwIfAiVaultScanCancelled(options.signal)
        noteAiVaultScanReading(options.signal)

        const parsedSessions = await parseSessionCandidates({
          candidates: parseCandidates,
          limit,
          platform,
          executionHostId,
          issues,
          parseStats,
          signal: options.signal,
          antigravityWorkspaceResolver,
          settled: (candidate, parsed) => workload?.settle(candidate, 'global', parsed)
        })

        const cappedSessions = dedupeScannedSessions(parsedSessions)
          .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
          .slice(0, limit)

        const scopeSessions = await scanInScopeSessions({
          inventory,
          discoveries,
          scopePaths: options.scopePaths ?? [],
          limit,
          alreadyParsedFilePaths: new Set(cappedSessions.map((session) => session.filePath)),
          platform,
          executionHostId,
          issues,
          parseStats,
          signal: options.signal
        })
        // Scope discovery may parse nothing; check cancellation before returning a completed scan.
        throwIfAiVaultScanCancelled(options.signal)
        for (const refusal of cursorChatMetaRefusals()) {
          // Report each refused chats root once across its Cursor transcripts.
          recordSessionScanIssue(issues, {
            agent: 'cursor',
            path: refusal.chatsRoot,
            message: refusal.message
          })
        }

        span.setAttribute('candidates', candidates.length)
        span.setAttribute('reused', parseStats.reused)
        span.setAttribute('incremental', parseStats.incremental)
        span.setAttribute('fullParses', parseStats.fullParses)
        span.setAttribute('earlyStopped', parseStats.earlyStopped)
        span.setAttribute('bytesRead', parseStats.bytesRead)
        span.setAttribute('issues', issues.length)

        return {
          sessions: mergeSessions(cappedSessions, scopeSessions),
          issues: issues.map((issue) => ({ executionHostId, ...issue })),
          scannedAt: new Date().toISOString()
        }
      })
    )
  )
}

// Merge scope recovery without applying the global recency cap again.
function mergeSessions(
  cappedSessions: AiVaultSession[],
  scopeSessions: AiVaultSession[]
): AiVaultSession[] {
  if (scopeSessions.length === 0) {
    return cappedSessions
  }
  const byId = new Map<string, AiVaultSession>()
  for (const session of cappedSessions) {
    byId.set(session.id, session)
  }
  for (const session of scopeSessions) {
    byId.set(session.id, session)
  }
  return [...byId.values()].sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
}

async function scanInScopeSessions(args: {
  discoveries: SessionFileDiscovery[]
  scopePaths: readonly string[]
  limit: number
  alreadyParsedFilePaths: ReadonlySet<string>
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  signal?: AbortSignal
}): Promise<AiVaultSession[]> {
  if (args.scopePaths.length === 0) {
    return []
  }
  const candidates: SessionFileCandidate[] = []
  for (const layout of CWD_BUCKET_LAYOUTS) {
    const files = await discoverInScopeCwdBucketFiles(layout, {
      rootDirs: args.discoveries
        .filter((discovery) => discovery.agent === layout.agent)
        .map((discovery) => discovery.rootDir),
      scopePaths: args.scopePaths,
      limit: args.limit,
      excludedFilePaths: args.alreadyParsedFilePaths,
      issues: args.issues
    })
    candidates.push(...files.map((file) => ({ agent: layout.agent, file, codexHome: null })))
  }
  if (candidates.length === 0) {
    return []
  }
  noteAiVaultScanReading(args.signal, candidates.length)
  // Parse every in-scope candidate (limit === candidate count never early-stops).
  return parseSessionCandidates({
    candidates,
    limit: candidates.length,
    platform: args.platform,
    executionHostId: args.executionHostId,
    issues: args.issues,
    parseStats: args.parseStats,
    signal: args.signal
  })
}

async function parseSessionCandidates(args: {
  candidates: SessionFileCandidate[]
  limit: number
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  signal?: AbortSignal
  antigravityWorkspaceResolver?: AntigravityWorkspaceResolver
}): Promise<AiVaultSession[]> {
  const sessions = new ScannedSessionCollection()

  for (let index = 0; index < args.candidates.length;) {
    throwIfAiVaultScanCancelled(args.signal)
    if (
      canStopParsingSessions(sessions, args.limit, candidateFileTime(args.candidates[index]?.file))
    ) {
      break
    }

    const remaining = args.candidates.length - index
    const needed = Math.max(args.limit - sessions.size, 1)
    const batchSize = Math.min(SESSION_PARSE_CONCURRENCY, needed, remaining)
    const batch = args.candidates.slice(index, index + batchSize)
    const results = await Promise.all(
      batch.map((candidate) =>
        parseSessionCandidate(
          candidate,
          args.platform,
          args.executionHostId,
          args.parseStats,
          args.antigravityWorkspaceResolver,
          args.signal
        )
      )
    )
    // An abort can land while a batch settles: a read it cut short is not that
    // file's issue, and a partial parse must never be cached or returned.
    throwIfAiVaultScanCancelled(args.signal)
    noteAiVaultScanFilesRead(args.signal, batch.length)

    for (const result of results) {
      if (result.issue) {
        recordSessionScanIssue(args.issues, result.issue)
      }
      if (result.session && !isConversationNameRequestSession(result.session)) {
        sessions.add(result.session)
      }
    }

    index += batchSize
  }

  return [...sessions.values()]
}

async function parseSessionCandidate(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  executionHostId: ExecutionHostId,
  parseStats: SessionParseStats,
  antigravityWorkspaceResolver?: AntigravityWorkspaceResolver,
  signal?: AbortSignal
): Promise<SessionParseResult> {
  try {
    let session = await parseListedSessionFile(candidate, platform, parseStats, signal)
    if (session && candidate.antigravityHistoryPath && antigravityWorkspaceResolver) {
      session = await antigravityWorkspaceResolver.enrich(session, candidate.antigravityHistoryPath)
    }
    return {
      session: session ? withSessionExecutionHost(session, executionHostId) : null,
      issue: skippedRecordIssue(candidate, executionHostId)
    }
  } catch (err) {
    return {
      session: null,
      issue: {
        executionHostId,
        agent: candidate.agent,
        path: candidate.file.path,
        message: errorMessage(err)
      }
    }
  }
}

// The session still listed, but part of it did not: report the loss as a notice
// so the panel does not count it as a skipped transcript file.
function skippedRecordIssue(
  candidate: SessionFileCandidate,
  executionHostId: ExecutionHostId
): AiVaultScanIssue | null {
  const entry = getSessionParseCacheEntry(candidate.file.path)
  const skipped = entry?.resume?.skippedRecords ?? entry?.skippedRecords
  const message = skipped ? describeSkippedTranscriptRecords(skipped) : null
  if (message === null) {
    return null
  }
  return {
    executionHostId,
    agent: candidate.agent,
    kind: 'notice',
    path: candidate.file.path,
    message
  }
}

function withSessionExecutionHost(
  session: AiVaultSession,
  executionHostId: ExecutionHostId
): AiVaultSession {
  if (session.executionHostId === executionHostId) {
    return session
  }
  return {
    ...session,
    executionHostId,
    id: `${executionHostId}:${session.agent}:${session.sessionId}:${session.filePath}`
  }
}
