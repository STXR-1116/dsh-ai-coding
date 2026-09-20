import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { WorkspaceGateway } from '../src/workspace-gateway.ts'

/** Waits until one owned subscription reaches the expected state. */
async function waitForState(gateway: WorkspaceGateway, subscriptionId: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await gateway.streamState(subscriptionId)).status === status) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`subscription ${subscriptionId} never reached ${status}`)
}

describe('WorkspaceGateway', () => {
  it('exports the browser cloud workspace operations under one typed Remote namespace', () => {
    const gateway = new WorkspaceGateway(new Context(), {})

    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'cloudWorkspaces',
      namespace: 'cloudWorkspaces',
    })
    expect(remoteMethods(gateway).map(method => method.method)).toEqual([
      'agentTypes',
      'agentProfiles',
      'agentProfileVersion',
      'agentTypeSchema',
      'codeSources',
      'workspaces',
      'workspace',
      'workspaceFiles',
      'workspaceFileContent',
      'workspaceChanges',
      'workspacePreview',
      'workspacePreviewUrl',
      'createWorkspace',
      'workspaceAction',
      'deleteWorkspace',
      'createPullRequest',
      'discardChanges',
      'gitCommit',
      'createRun',
      'workspacePlans',
      'plan',
      'createPlan',
      'updatePlan',
      'confirmPlan',
      'pauseRun',
      'resumeRun',
      'runCheckpoint',
      'runPulse',
      'contextLens',
      'suppressContextLensMemory',
      'runAssetSnapshot',
      'profileEditContext',
      'assetCandidates',
      'dryRunProfile',
      'createProfileVersion',
      'updateProfileDraft',
      'publishProfileVersion',
      'workspaceRuns',
      'run',
      'runApproval',
      'decideApproval',
      'takeoverRun',
      'cancelRun',
      'retryRun',
      'streamState',
      'startStream',
      'stopStream',
      'streamEventsAfter',
    ])
  })

  it('wires the Host stream start and stop through the gateway', async () => {
    const gateway = new WorkspaceGateway(new Context(), {})
    expect(await gateway.streamState('unknown-subscription')).toMatchObject({ status: 'idle' })
    // Without credentials or a static token the account is signed out and the stream stops.
    const unsigned = await gateway.startStream({ projectId: 'project-alpha', lastEventId: 'evt-000001' })
    await waitForState(gateway, unsigned.subscriptionId, 'stopped')
    expect(await gateway.streamState(unsigned.subscriptionId)).toMatchObject({ status: 'stopped' })
    await gateway.stopStream(unsigned.subscriptionId)
    expect(await gateway.streamState(unsigned.subscriptionId)).toMatchObject({ status: 'idle' })

    // A real local origin returning 503 keeps the loop reconnecting without any proxy in the way.
    const failing = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const server = createServer((_request, response) => {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: '维护中', request_id: 'req-1', data: null }))
      })
      server.listen(0, '127.0.0.1', () =>{  resolve(server) })
    })
    const reachable = new WorkspaceGateway(new Context(), {
      apiBaseUrl: `http://127.0.0.1:${(failing.address() as AddressInfo).port}`,
      authMode: 'static-token',
      accessToken: 'static-token',
    })
    const subscription = await reachable.startStream({ projectId: 'project-alpha' })
    // The stream loop advances asynchronously; assert the wiring, not a racing mid-state.
    await new Promise(resolve => setTimeout(resolve, 20))
    const live = await reachable.streamState(subscription.subscriptionId)
    expect(live.status === 'connecting' || live.status === 'reconnecting' || live.status === 'live').toBe(true)
    await reachable.stopStream(subscription.subscriptionId)
    expect(await reachable.streamState(subscription.subscriptionId)).toMatchObject({ status: 'idle' })
    failing.closeAllConnections()
    failing.close()
  })
})
