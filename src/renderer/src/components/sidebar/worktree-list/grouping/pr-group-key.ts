import type { AppState } from '@/store/types'
import { branchName } from '@/lib/git-utils'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from '@/store/slices/github-cache-key'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { isGitHubPRSuppressed } from '../../../../../../shared/worktree/github-pr-suppression'
import {
  getPRGroupKeyForState,
  type PRGroupKey
} from '../../../../../../shared/workspace-view/workspace-pr-groups'
import type { SidebarPRGroupReader } from '../../../../../../shared/sidebar-list/row-types'

export function getPRGroupKey(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  settings?: AppState['settings']
): PRGroupKey {
  const repo = repoMap.get(worktree.repoId)
  const branch = branchName(worktree.branch)
  const repoScopedCacheKey =
    repo && branch
      ? getGitHubPRCacheKey(
          repo.path,
          repo.id,
          branch,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const canUseLegacyPRCache = repo !== undefined && !repo.connectionId && !repo.executionHostId
  const legacyRepoScopedCacheKey =
    canUseLegacyPRCache && branch ? getLegacyGitHubPRCacheKey(repo.path, repo.id, branch) : ''
  const legacyPathScopedCacheKey =
    canUseLegacyPRCache && branch ? getLegacyGitHubPRCacheKey(repo.path, undefined, branch) : ''
  // Why: PR refreshes now write repo-id scoped entries; legacy path entries may
  // still exist from persisted cache, but must not override fresher repo data.
  const prEntry = prCache
    ? ((repoScopedCacheKey
        ? (prCache[repoScopedCacheKey] as
            | { data?: { number?: number; state?: string } }
            | undefined)
        : undefined) ??
      (legacyRepoScopedCacheKey
        ? (prCache[legacyRepoScopedCacheKey] as
            | { data?: { number?: number; state?: string } }
            | undefined)
        : undefined) ??
      (legacyPathScopedCacheKey
        ? (prCache[legacyPathScopedCacheKey] as
            | { data?: { number?: number; state?: string } }
            | undefined)
        : undefined))
    : undefined
  const pr = prEntry?.data

  if (!pr || (typeof pr.number === 'number' && isGitHubPRSuppressed(worktree, pr.number))) {
    return 'in-progress'
  }
  return getPRGroupKeyForState(pr.state ?? '')
}

/** The PR lane reader the shared builder takes, bound to the window's PR cache. */
export function createSidebarPRGroupReader(
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null,
  settings?: AppState['settings']
): SidebarPRGroupReader {
  return (worktree) => getPRGroupKey(worktree, repoMap, prCache, settings)
}
