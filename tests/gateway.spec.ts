import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { TeamSkillGateway } from '../src/gateway.ts'

describe('TeamSkillGateway', () => {
  it('exports the browser Team Skill operations under one typed Remote namespace', () => {
    const gateway = new TeamSkillGateway(new Context(), {
      stateDirectory: 'C:/dsh/ai-coding-platform',
      globalSkillRoot: 'C:/dsh/skills',
    })

    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'teamSkills',
      namespace: 'teamSkills',
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'login', invocation: { kind: 'direct' } },
      { method: 'account', invocation: { kind: 'direct' } },
      { method: 'refreshAccount', invocation: { kind: 'direct' } },
      { method: 'changePassword', invocation: { kind: 'direct' } },
      { method: 'logout', invocation: { kind: 'direct' } },
      { method: 'accessSummary', invocation: { kind: 'direct' } },
      { method: 'projects', invocation: { kind: 'direct' } },
      { method: 'project', invocation: { kind: 'direct' } },
      { method: 'catalog', invocation: { kind: 'direct' } },
      { method: 'knowledgeBases', invocation: { kind: 'direct' } },
      { method: 'knowledgeSearch', invocation: { kind: 'direct' } },
      { method: 'knowledgePreview', invocation: { kind: 'direct' } },
      { method: 'memoryRecall', invocation: { kind: 'direct' } },
      { method: 'memoryCapture', invocation: { kind: 'direct' } },
      { method: 'memoryList', invocation: { kind: 'direct' } },
      { method: 'memoryCandidatesConfirm', invocation: { kind: 'direct' } },
      { method: 'memoryGet', invocation: { kind: 'direct' } },
      { method: 'memoryUpdate', invocation: { kind: 'direct' } },
      { method: 'memoryDelete', invocation: { kind: 'direct' } },
      { method: 'memoryJobs', invocation: { kind: 'direct' } },
      { method: 'memoryAudit', invocation: { kind: 'direct' } },
      { method: 'configureKnowledgeSelection', invocation: { kind: 'direct' } },
      { method: 'clearKnowledgeSelection', invocation: { kind: 'direct' } },
      { method: 'configureProjectMemory', invocation: { kind: 'direct' } },
      { method: 'clearProjectMemory', invocation: { kind: 'direct' } },
      { method: 'collectorStatus', invocation: { kind: 'direct' } },
      { method: 'configureCollectorProject', invocation: { kind: 'direct' } },
      { method: 'clearCollectorProject', invocation: { kind: 'direct' } },
      { method: 'pauseCollector', invocation: { kind: 'direct' } },
      { method: 'resumeCollector', invocation: { kind: 'direct' } },
      { method: 'flushCollector', invocation: { kind: 'direct' } },
      { method: 'clearPendingCollectorData', invocation: { kind: 'direct' } },
      { method: 'installations', invocation: { kind: 'direct' } },
      { method: 'syncReleaseStatus', invocation: { kind: 'direct' } },
      { method: 'trustCard', invocation: { kind: 'direct' } },
      { method: 'install', exportName: 'installSkill', invocation: { kind: 'direct' } },
      { method: 'uninstall', exportName: 'uninstallSkill', invocation: { kind: 'direct' } },
    ])
  })
})
