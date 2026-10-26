// Lost writes release Working as unknown; taken-but-unechoed sends release doubt; queued sends stay held.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import {
  DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED,
  DISPATCH_DOUBT_PROVIDER_IDLE,
  DISPATCH_DOUBT_WRITE_OUTCOME_UNKNOWN
} from '../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import { hasUnansweredStructuredAgentSessionDispatch } from '../../shared/structured-agent-session-unanswered-dispatch'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-idle-release'
const PROVIDER_SESSION = claudeSessionIdForOrcaSession(SESSION)
const CALLER = { callerKey: 'client-1' }

let claude = createScriptedClaudeRuntime([SESSION])
let operations = 0

afterEach(async () => {
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

function fence(host: StructuredAgentSessionHost): number {
  return host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
}

async function send(host: StructuredAgentSessionHost, text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`,
      expectedRuntimeFence: fence(host),
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true })
  return sent.ok ? sent.value.clientMessageId : ''
}

async function submission(host: StructuredAgentSessionHost, clientMessageId: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

function sessionState(state: 'running' | 'idle'): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: `state-${state}`,
    session_id: PROVIDER_SESSION
  }
}

describe('a live Claude chat whose CLI reports idle', () => {
  it('releases a send whose write ended in doubt, and leaves a pending one alone', async () => {
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    const child = claude.child(SESSION)
    // Handed to the SDK, then the write's outcome was lost.
    child.connection.send = async (_message, beforeDispatch) => {
      await beforeDispatch?.()
      throw new Error('stdin write stalled')
    }
    const doubted = await send(host, 'first')
    await vi.waitFor(async () =>
      expect(await submission(host, doubted)).toMatchObject({ dispatchState: 'unknown' })
    )
    // Written, never echoed: its dispatch has returned, but nothing has settled it.
    child.connection.send = async (_message, beforeDispatch) => {
      await beforeDispatch?.()
    }
    const pending = await send(host, 'second')
    await vi.waitFor(async () =>
      expect(await submission(host, pending)).toMatchObject({ dispatchState: 'pending' })
    )

    child.handlers.onMessage?.(sessionState('running'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    // POSITIVE CONTROL: only idle releases it.
    expect((await submission(host, doubted))?.recovered).toBeUndefined()

    child.handlers.onMessage?.(sessionState('idle'))

    await vi.waitFor(async () =>
      expect(await submission(host, doubted)).toMatchObject({
        dispatchState: 'unknown',
        recovered: true,
        // The write's own doubt is the sharper fact, so it survives the release.
        reason: `${DISPATCH_DOUBT_WRITE_OUTCOME_UNKNOWN}: stdin write stalled`
      })
    )

    await vi.waitFor(() => expect(host.currentWork(SESSION)?.working()).toBe(false))
    const raw = await submission(host, doubted)
    expect(raw?.recovered).toBeUndefined()
    const published = raw && host.currentWork(SESSION)?.publishedSubmission(raw)
    expect(published).toMatchObject({ dispatchState: 'unknown', recovered: true })
    expect(published && hasUnansweredStructuredAgentSessionDispatch([published], fence(host))).toBe(
      false
    )

    child.connection.send = async (message, beforeDispatch) => {
      await beforeDispatch?.()
      child.handlers.onMessage?.({ ...message, session_id: PROVIDER_SESSION })
      child.handlers.onMessage?.({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'later-result',
        session_id: PROVIDER_SESSION
      })
    }
    const later = await send(host, 'second succeeds')
    await vi.waitFor(async () =>
      expect(await submission(host, later)).toMatchObject({ dispatchState: 'accepted' })
    )
    await vi.waitFor(() => expect(host.currentWork(SESSION)?.working()).toBe(false))
    child.exit(scriptedClaudeExitError('claude stream-json exited (code 137)'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    )
    const snapshot = await host.journalSnapshot(SESSION)
    expect(snapshot.items.some((item) => item.body.kind === 'status' && item.body.failure)).toBe(
      false
    )
    expect(
      snapshot.items.some((item) => item.body.kind === 'turn' && item.body.state === 'completed')
    ).toBe(true)
    expect(await submission(host, doubted)).toMatchObject({ dispatchState: 'unknown' })
  })
})

function lifecycle(commandUuid: string, state: string): Record<string, unknown> {
  return {
    type: 'command_lifecycle',
    command_uuid: commandUuid,
    state,
    uuid: `lifecycle-${state}`,
    session_id: PROVIDER_SESSION
  }
}

describe('a live Claude chat whose CLI took a send and let it go without an echo', () => {
  it.each([
    ['its turn ended cancelled', 'cancelled', DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED],
    ['it went idle with no terminal state', 'idle', DISPATCH_DOUBT_PROVIDER_IDLE]
  ])('records released doubt when %s', async (_label, ending, reason) => {
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    const child = claude.child(SESSION)
    let sentUuid = ''
    child.connection.send = async (message, beforeDispatch) => {
      await beforeDispatch?.()
      sentUuid = String(message.uuid)
    }
    const taken = await send(host, 'retrying')
    await vi.waitFor(() => expect(sentUuid).not.toBe(''))
    expect(await submission(host, taken)).toMatchObject({ dispatchState: 'pending' })
    child.handlers.onMessage?.(lifecycle(sentUuid, 'queued'))
    child.handlers.onMessage?.(lifecycle(sentUuid, 'started'))
    expect(host.deps.adapter.holdsDispatch?.(SESSION)).toBe(true)

    child.handlers.onMessage?.(
      ending === 'idle' ? sessionState('idle') : lifecycle(sentUuid, ending)
    )

    await vi.waitFor(async () =>
      expect(await submission(host, taken)).toMatchObject({
        dispatchState: 'unknown',
        recovered: true,
        reason
      })
    )
    expect(host.deps.adapter.holdsDispatch?.(SESSION)).toBe(false)
    expect(host.currentWork(SESSION)?.working()).toBe(false)
    expect(
      hasUnansweredStructuredAgentSessionDispatch((await host.journalSnapshot(SESSION)).submissions)
    ).toBe(false)
  })

  it('holds a send it has only queued, through an idle that may precede its start', async () => {
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    const child = claude.child(SESSION)
    let sentUuid = ''
    child.connection.send = async (message, beforeDispatch) => {
      await beforeDispatch?.()
      sentUuid = String(message.uuid)
    }
    const queued = await send(host, 'behind a turn')
    await vi.waitFor(() => expect(sentUuid).not.toBe(''))
    // Positive control: a write alone does not prove the CLI took the dispatch.
    expect(host.deps.adapter.holdsDispatch?.(SESSION)).toBe(false)

    child.handlers.onMessage?.(lifecycle(sentUuid, 'queued'))
    expect(host.deps.adapter.holdsDispatch?.(SESSION)).toBe(true)
    child.handlers.onMessage?.(sessionState('idle'))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(host.deps.adapter.holdsDispatch?.(SESSION)).toBe(true)
    expect(await submission(host, queued)).toMatchObject({ dispatchState: 'pending' })
    expect((await submission(host, queued))?.recovered).toBeUndefined()
  })
})
