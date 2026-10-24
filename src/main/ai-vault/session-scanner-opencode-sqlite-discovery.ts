import { basename, extname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import { listOpenCodeSqliteSessionsViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'
import type { FileWithMtime, SessionFileDiscovery } from './session-scanner-types'

export { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'

function sessionIdFromLegacyFilePath(filePath: string): string {
  return basename(filePath, extname(filePath))
}

/** Prefer SQLite candidates over stale legacy files sharing a session ID, before parsing either. */
export async function discoverOpenCodeSessions(args: {
  storageDir: string
  dbPaths: readonly string[]
  limitPerAgent: number
  issues: AiVaultScanIssue[]
  signal?: AbortSignal
}): Promise<SessionFileDiscovery> {
  const walksScope = scopeWalksAgentFiles('opencode', args.scopePaths)
  const listSqlite = (scopePaths?: readonly string[]) =>
    listOpenCodeSqliteSessionsViaWorker({
      dbPaths: args.dbPaths,
      limit: args.limitPerAgent,
      issues: args.issues,
      scopePaths,
      signal: args.signal
    })
  const [fileDiscovery, sqliteCandidates, sqliteScopeCandidates] = await Promise.all([
    discoverFiles({
      rootDir: join(args.storageDir, 'session'),
      limit: args.limitPerAgent,
      agent: 'opencode',
      issues: args.issues,
      extensions: ['.json'],
      signal: args.signal
    }),
    // Why (#8864): the SQLite list leg runs on a worker thread; only this leg
    // moves off the main thread, the filesystem scan stays inline.
    listOpenCodeSqliteSessionsViaWorker({
      dbPaths: args.dbPaths,
      limit: args.limitPerAgent,
      issues: args.issues,
      signal: args.signal
    })
  ])

  const sqliteFiles = sqliteCandidates.map((c) => c.file)
  const sqliteScopeFiles = sqliteScopeCandidates?.map((c) => c.file)
  const sqliteSessionIds = new Set<string>()
  for (const file of sqliteFiles) {
    const parsed = splitOpenCodeSqliteCandidate(file.path)
    if (parsed) {
      sqliteSessionIds.add(parsed.sessionId)
    }
  }
  const dedupedFileDiscovery: FileWithMtime[] = []
  for (const file of fileDiscovery.files) {
    if (!sqliteSessionIds.has(sessionIdFromLegacyFilePath(file.path))) {
      dedupedFileDiscovery.push(file)
    }
  }

  return {
    agent: 'opencode' as const,
    rootDir: fileDiscovery.rootDir,
    files: [...dedupedFileDiscovery, ...sqliteFiles]
  }
}
