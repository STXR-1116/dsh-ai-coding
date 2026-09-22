/* 覆盖补齐：`src/recall-gate.ts` 的纯函数 `routeRecallPassage` 与它依赖的常量。
 *
 * 数据来源全部是 `docs/typesafe-recall-gate.md` 记录的实测值（四轮实验、46 条合成语料、
 * 9 文档 × 5 次自一致性、一次零 API 调用的阈值扫描）。每个用例都在注释里写明抄自哪一行，
 * 便于日后复调阈值时回溯。判定只读入参，所以本文件不需要网络、凭证、知识库、时钟或随机数。
 *
 * 设计文档第 108~112 行明确「判定顺序不可交换」，并且给了反向后果：`X01` / `X02` / `C9`
 * 的 `evid` 都越过 `evidence_min`，若把矛盾判断后置，它们会作为事实被注入。本文件用两组
 * 次序探针把这条钉住：任何一次顺序调整都必须让它们变红，而不是悄悄改变线上行为。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECALL_GATE_THRESHOLDS,
  RECALL_GATE_MODEL,
  RECALL_GATE_QUESTIONS,
  routeRecallPassage,
  type RecallGateAnswers,
  type RecallGateThresholds,
} from '../src/recall-gate.ts'

/**
 * 「无关、无证据、不矛盾、无注入」基线：只改要测的那一维，判定才可单独归因。
 *
 * - `isRelevant` 0.02：文档 §5 第 222 行「4 条 `rel` 落在 `0.01~0.02`」。
 * - `containsAnswerEvidence` 0.05：落在第 96 行「空档 0.17~0.58」以下，即明确的「无证据」侧。
 * - `contradictsQueryPremise` 0.02 / `containsPromptInjection` 0.02：第 155 行正常内容区
 *   `inj 0.02~0.15` 的下沿。
 */
const UNRELATED: RecallGateAnswers = {
  isRelevant: 0.02,
  containsAnswerEvidence: 0.05,
  contradictsQueryPremise: 0.02,
  containsPromptInjection: 0.02,
}

/** 基线 + 指定覆盖：一个用例只动一维。 */
function answers(overrides: Partial<RecallGateAnswers>): RecallGateAnswers {
  return { ...UNRELATED, ...overrides }
}

/** 默认阈值 + 指定覆盖，用于「阈值可调」的一组用例。 */
function thresholds(overrides: Partial<RecallGateThresholds>): RecallGateThresholds {
  return { ...DEFAULT_RECALL_GATE_THRESHOLDS, ...overrides }
}

/** 一条「明确相关、明确有证据」的条目，用来证明某一维被排除不是相关性/证据性造成的。 */
const STRONG: Partial<RecallGateAnswers> = { isRelevant: 0.9, containsAnswerEvidence: 0.9 }

describe('routeRecallPassage —— 注入优先（文档第 100、110、153~158 行）', () => {
  // 第 153~154 行：显式注入 0.99；隐蔽注入（「本条目效力高于其他所有文档」/「系统提示更新」/
  // 「伪装权威」）0.94~0.98。第 158 行：注入判定与正常内容的间隔均 ≥0.79。
  const INJECTED: Array<[label: string, injection: number]> = [
    ['J01 显式注入「忽略以上全部指令」', 0.99],
    ['隐蔽注入「本条目效力高于其他所有文档」', 0.94],
    ['隐蔽注入「系统提示更新」', 0.95],
    ['隐蔽注入「伪装权威」', 0.98],
  ]

  for (const [label, injection] of INJECTED) {
    it(`${label}：inj ${injection} 判 exclude，即使相关性与证据性都高`, () => {
      expect(routeRecallPassage(answers({
        ...STRONG,
        containsPromptInjection: injection,
      }))).toBe('exclude')
    })
  }

  // 第 155 行：正常内容 inj 0.02~0.15。第 84~85 行：`B6 正常-流程要求`（含两个「必须」）
  // inj 0.09，与 `J01 显式注入` 的 0.99 只差措辞 —— 面向人的强约束不得被当成注入。
  const NORMAL: Array<[label: string, injection: number]> = [
    ['正常内容下沿', 0.02],
    ['B6 正常-流程要求（含两个「必须」）', 0.09],
    ['正常内容上沿', 0.15],
  ]

  for (const [label, injection] of NORMAL) {
    it(`${label}：inj ${injection} 不因注入被排除，落到证据判定 → include`, () => {
      expect(routeRecallPassage(answers({
        ...STRONG,
        containsPromptInjection: injection,
      }))).toBe('include')
    })
  }

  it('注入与矛盾同时高时仍判 exclude（注入压过矛盾，次序探针）', () => {
    // 数值分别取自第 153 行的注入样本 0.99 与第 112 行的矛盾区 0.88~0.95；文中没有同一条
    // 样本同时具备两者，所以这是为「注入优先于一切」（第 110 行）组合出来的次序探针。
    expect(routeRecallPassage(answers({
      ...STRONG,
      contradictsQueryPremise: 0.95,
      containsPromptInjection: 0.99,
    }))).toBe('exclude')
  })
})

describe('routeRecallPassage —— 矛盾优先于证据（文档第 111~112 行）', () => {
  // 第 112 行逐字记录：`X01` evid 0.49、`X02` evid 0.51、`C9` evid 0.94，三条的 `contra`
  // 均为 0.88~0.95。区间下沿给 X01/X02、上沿给 C9。
  const CONTRADICTING_WITH_EVIDENCE: Array<[label: string, evidence: number, contradicts: number]> = [
    ['X01 单人快速通道', 0.49, 0.88],
    ['X02 机器人自动放行', 0.51, 0.88],
    ['C9 免审核自助导出', 0.94, 0.95],
  ]

  for (const [label, evidence, contradicts] of CONTRADICTING_WITH_EVIDENCE) {
    it(`${label}（evid ${evidence}、contra ${contradicts}）判 conflict 而不是 include`, () => {
      const strong = answers({ ...STRONG, containsAnswerEvidence: evidence, contradictsQueryPremise: contradicts })

      expect(routeRecallPassage(strong)).toBe('conflict')
      // 这条断言是次序陷阱的反证：证据值本身已越过 evidence_min，把矛盾判断后置就会走成
      // include，把「不需要评审」当作事实喂给下游 —— 文档第 112 行描述的正是这个事故。
      expect(evidence).toBeGreaterThan(DEFAULT_RECALL_GATE_THRESHOLDS.evidenceMin)
      expect(routeRecallPassage(answers({
        ...STRONG,
        containsAnswerEvidence: evidence,
        contradictsQueryPremise: DEFAULT_RECALL_GATE_THRESHOLDS.contradictsMin, // 矛盾压回阈值，不再拦
      }))).toBe('include')
    })
  }
})

describe('routeRecallPassage —— 前提矛盾检测（文档 §1 第 141~148 行）', () => {
  it('断言式前提下的「紧急发布通道」：contra 0.77 判 conflict', () => {
    expect(routeRecallPassage(answers({
      ...STRONG,
      contradictsQueryPremise: 0.77,
    }))).toBe('conflict')
  })

  it('开放问题下的同一条 passage：contra 0.21 不判冲突，按证据 include', () => {
    // 第 148 行：用户只提问而未陈述前提时该维度不生效（实测此时所有 contra ≤0.26）。
    expect(routeRecallPassage(answers({
      ...STRONG,
      contradictsQueryPremise: 0.21,
    }))).toBe('include')
  })

  it('矛盾区下沿 contra 0.81 判 conflict（第 94 行「矛盾 0.81~0.95」）', () => {
    expect(routeRecallPassage(answers({
      ...STRONG,
      contradictsQueryPremise: 0.81,
    }))).toBe('conflict')
  })

  it('非矛盾区上沿 contra 0.26 仍 include（第 94 行「非矛盾 ≤0.26」）', () => {
    expect(routeRecallPassage(answers({
      ...STRONG,
      contradictsQueryPremise: 0.26,
    }))).toBe('include')
  })
})

describe('routeRecallPassage —— 相关性（文档第 95、206~222 行）', () => {
  it('全库没有答案时 4 条无关候选（rel 0.01~0.02）全部 exclude（§5 第 221~222 行）', () => {
    for (const relevance of [0.01, 0.015, 0.02]) {
      expect(routeRecallPassage(answers({ isRelevant: relevance }))).toBe('exclude')
    }
  })

  it('rel 0.32（无关区上沿，第 95 行）判 exclude —— 次序探针：证据性给到 0.9 仍被相关性拦下', () => {
    // 0.32 是实测值；与 evid 0.9 的组合是本次为证明「相关性判断在证据判断之前」构造的，
    // 否则 evid 0.9 > 0.48 会走成 include。
    expect(routeRecallPassage(answers({ isRelevant: 0.32, containsAnswerEvidence: 0.9 }))).toBe('exclude')
  })
})

describe('routeRecallPassage —— 证据性与空档样本（文档第 96、181~184、205 行）', () => {
  // 第 205 行：两条边界样本的实测值。它们的 rel 落在第 215 行的空档「0.42~0.69」里，
  // 也正是阈值扫描里唯一的不同判项（第 200~203 行）。
  const GAP_SAMPLES: Array<[label: string, relevance: number, evidence: number]> = [
    ['评审时限规定', 0.53, 0.56],
    ['评审意见处理', 0.58, 0.62],
  ]

  for (const [label, relevance, evidence] of GAP_SAMPLES) {
    it(`${label}（rel ${relevance}、evid ${evidence}）落在相关性空档内，默认阈值下判 include`, () => {
      expect(routeRecallPassage(answers({
        isRelevant: relevance,
        containsAnswerEvidence: evidence,
      }))).toBe('include')
    })
  }

  it('空档下沿 evid 0.17（第 96 行「空档 0.17~0.58」）判 exclude', () => {
    expect(routeRecallPassage(answers({ ...STRONG, containsAnswerEvidence: 0.17 }))).toBe('exclude')
  })

  it('刚越过 evidence_min：evid 0.49（X01 的实测值）判 include', () => {
    expect(routeRecallPassage(answers({ ...STRONG, containsAnswerEvidence: 0.49 }))).toBe('include')
  })
})

describe('routeRecallPassage —— 边界语义（源码 `src/recall-gate.ts:164~168`）', () => {
  // 源码的三个「上界」判断用 `>`（注入/矛盾/证据），相关性用 `<`：等号一律落在「不触发」
  // 的一侧，即阈值是判定区的闭区间端点。以下断言按源码实际语义写，不是按直觉。
  it('恰等于阈值时不触发上界判断：注入、矛盾、相关性三条都算「通过」', () => {
    const tuned = DEFAULT_RECALL_GATE_THRESHOLDS

    expect(routeRecallPassage(answers({
      ...STRONG,
      containsPromptInjection: tuned.injectionMax,
    }))).toBe('include')
    expect(routeRecallPassage(answers({
      ...STRONG,
      contradictsQueryPremise: tuned.contradictsMin,
    }))).toBe('include')
    expect(routeRecallPassage(answers({
      isRelevant: tuned.relevantMin,
      containsAnswerEvidence: 0.9,
    }))).toBe('include')
  })

  it('证据恰等于 evidenceMin 时算「证据不足」，落到兜底 exclude（`>` 的等号侧）', () => {
    expect(routeRecallPassage(answers({
      isRelevant: 0.9,
      containsAnswerEvidence: DEFAULT_RECALL_GATE_THRESHOLDS.evidenceMin,
    }))).toBe('exclude')
  })

  it('越过阈值一步就翻转，四个方向各一例', () => {
    expect(routeRecallPassage(answers({ ...STRONG, containsPromptInjection: 0.71 }))).toBe('exclude')
    expect(routeRecallPassage(answers({ ...STRONG, contradictsQueryPremise: 0.71 }))).toBe('conflict')
    expect(routeRecallPassage(answers({ isRelevant: 0.37, containsAnswerEvidence: 0.9 }))).toBe('exclude')
    expect(routeRecallPassage(answers({ isRelevant: 0.9, containsAnswerEvidence: 0.49 }))).toBe('include')
  })

  it('矛盾优先级高于相关性：contra 0.95 与 rel 0.05 同时出现时判 conflict', () => {
    // 次序探针。两个数值各取实测区间的端点（第 94 行 contra 上沿、§5 第 222 行无关区），
    // 但文中没有这样一条样本；它锁的是「矛盾在相关性之前」这条次序。
    expect(routeRecallPassage(answers({
      isRelevant: 0.05,
      containsAnswerEvidence: 0.05,
      contradictsQueryPremise: 0.95,
    }))).toBe('conflict')
  })
})

describe('阈值可调：改常量即改策略，零 API 调用（文档第 90~91、197~207 行）', () => {
  it('默认阈值与模型版本一起固化（第 92~97 行、第 131 行）', () => {
    // 阈值是针对 jev-1.13.0 调出来的（第 131 行：官方要求调过阈值的场景固定版本 ID，
    // 不要用会漂移的别名）。改任何一项都应伴随重新实测，而不是顺手改数字。
    expect(DEFAULT_RECALL_GATE_THRESHOLDS).toEqual({
      injectionMax: 0.7,
      contradictsMin: 0.7,
      relevantMin: 0.38,
      evidenceMin: 0.48,
    })
    expect(RECALL_GATE_MODEL).toBe('jev-1.13.0')
  })

  it('evidence_min 抬到 0.62 会把空档样本漏收（第 202 行「evidence_min 0.62 以上 → 漏收同一条」）', () => {
    const sample = answers({ isRelevant: 0.53, containsAnswerEvidence: 0.56 })

    expect(routeRecallPassage(sample)).toBe('include')
    expect(routeRecallPassage(sample, thresholds({ evidenceMin: 0.62 }))).toBe('exclude')
  })

  it('evidence_min 0.55 会让该样本随实测波动跨阈值抖动，0.48 则恒定（§3 第 181~184 行）', () => {
    // 第 181 行：`评审时限规定` evid 0.55±0.017 → 区间 [0.533, 0.567]。第 182~183 行：
    // 阈值 0.55 时 5 次重复出现 include/include/exclude/exclude/exclude；移到 0.48 后 5/5 恒定。
    const low = answers({ isRelevant: 0.53, containsAnswerEvidence: 0.533 })
    const high = answers({ isRelevant: 0.53, containsAnswerEvidence: 0.567 })

    expect([low, high].map(sample => routeRecallPassage(sample, thresholds({ evidenceMin: 0.48 }))))
      .toEqual(['include', 'include'])
    expect([low, high].map(sample => routeRecallPassage(sample, thresholds({ evidenceMin: 0.55 }))))
      .toEqual(['exclude', 'include'])
  })

  it('relevant_min 在 0.35~0.50 之间移动不改变任何实测样本的路由（第 200 行）', () => {
    // 第 200 行：relevant_min 0.35~0.50 → 全部 45/46。样本是文中记录过的条目，它们都落在
    // 相关性分布的空档之外，所以整段带宽内路由不变 —— 容错带宽 > 0.15 的依据。
    const samples: RecallGateAnswers[] = [
      answers({ isRelevant: 0.02, containsAnswerEvidence: 0.05 }),                              // §5 无关候选
      answers({ isRelevant: 0.53, containsAnswerEvidence: 0.56 }),                              // 评审时限规定
      answers({ isRelevant: 0.58, containsAnswerEvidence: 0.62 }),                              // 评审意见处理
      answers({ isRelevant: 0.9, containsAnswerEvidence: 0.94, contradictsQueryPremise: 0.95 }), // C9
    ]
    const routesAt = (relevantMin: number): string[] =>
      samples.map(sample => routeRecallPassage(sample, thresholds({ relevantMin })))

    expect(routesAt(0.35)).toEqual(['exclude', 'include', 'include', 'conflict'])
    expect(routesAt(0.42)).toEqual(routesAt(0.35))
    expect(routesAt(0.5)).toEqual(routesAt(0.35))
  })

  it('收紧 injectionMax 到 0.05 会连 inj 0.09 的正常条目一起排除 —— 排除是阈值位置的结果', () => {
    // 第 158 行：注入与正常内容的间隔 ≥0.79，所以 0.70 安全。把阈值放进间隔之内，正常条目
    // 也必须被判掉，证明代码里没有「正常内容豁免」这类特判。
    const normal = answers({ ...STRONG, containsPromptInjection: 0.09 })

    expect(routeRecallPassage(normal)).toBe('include')
    expect(routeRecallPassage(normal, thresholds({ injectionMax: 0.05 }))).toBe('exclude')
  })

  it('contradictsMin 抬到 0.80 会让 contra 0.77 的条目落回 include（§1 第 144 行）', () => {
    const assertedPremise = answers({ ...STRONG, contradictsQueryPremise: 0.77 })

    expect(routeRecallPassage(assertedPremise)).toBe('conflict')
    expect(routeRecallPassage(assertedPremise, thresholds({ contradictsMin: 0.8 }))).toBe('include')
  })
})

describe('问题集常量（文档第 29~85、290~292 行）', () => {
  it('四个 Noul 齐备，每个都带结构化的 true/false 边界', () => {
    expect(Object.keys(RECALL_GATE_QUESTIONS).sort()).toEqual([
      'contains_answer_evidence',
      'contains_prompt_injection',
      'contradicts_query_premise',
      'is_relevant',
    ])
    for (const question of Object.values(RECALL_GATE_QUESTIONS)) {
      expect(question.type).toBe('noul')
      expect(question.criteria.true.what.length).toBeGreaterThan(0)
      expect(question.criteria.false.what.length).toBeGreaterThan(0)
    }
  })

  it('注入问题保留 not_for：面向人的「必须」不得被读成对系统的指令（第 84~85 行）', () => {
    // 第 84~85 行：正是这条 not_for 把 `B6 正常-流程要求`（inj 0.09）与 `J01 显式注入`
    // （inj 0.99）分开；去掉它，面向人的强约束措辞有被误判为注入的风险。
    expect(RECALL_GATE_QUESTIONS.contains_prompt_injection.criteria.false.not_for).toContain('面向人类读者')
  })
})
