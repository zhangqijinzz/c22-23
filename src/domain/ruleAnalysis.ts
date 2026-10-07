import type {
  BusinessRule,
  RuleAnalysis,
  RuleCondition,
  RuleField,
  RuleOverlap,
  RuleProject,
  SampleInput,
} from '../models/ruleModel';
import { matchesRule } from './conditionEvaluator';

export const MAX_CASES = 120_000;
const MAX_EXAMPLES = 4;

/** 单次进度上报/让出事件循环时最多处理的叶子数量，避免高频 postMessage 拖慢计算。 */
export const DEFAULT_CHUNK_LEAVES = 400;
/** 单个分块最多占用的毫秒数；配合叶子上限，谁先到就停。 */
export const DEFAULT_CHUNK_BUDGET_MS = 14;
/** 进度上报最小间隔（毫秒）。 */
export const PROGRESS_THROTTLE_MS = 220;
/** 检查点结构版本，项目内容变化时签名不匹配会自动丢弃旧快照。 */
const CHECKPOINT_VERSION = 1;

/** 某次分析的进度信息，足够 UI 展示“已经处理到哪一部分”。 */
export interface AnalysisProgress {
  /** 已经处理完成的叶子组合数量。 */
  processed: number;
  /** 计划处理的叶子总量（受 MAX_CASES 截断时等于 MAX_CASES）。 */
  total: number;
  /** 0~100 的整数百分比。 */
  percent: number;
  /** 正在处理的字段维度名称（最外层尚未走完的字段）。 */
  stageLabel?: string;
  /** 当前维度内的分段序号，从 1 开始。 */
  stageSegment: number;
  /** 当前维度的分段总数。 */
  stageTotal: number;
  /** 是否从上次中断的快照续算。 */
  resumed: boolean;
  /** 输入空间是否超过单次分析上限。 */
  truncated: boolean;
}

/** 可结构化克隆的续算快照。状态归约只依赖叶子访问顺序，因此续算与一次跑完严格等价。 */
export interface AnalysisCheckpoint {
  version: number;
  signature: string;
  offset: number;
  checkedCases: number;
  coveredCases: number;
  truncated: boolean;
  seen: string[];
  visible: string[];
  uncoveredExamples: SampleInput[];
  overlaps: RuleOverlap[];
  totalCases: number;
}

export interface AnalysisPacing {
  chunkLeaves?: number;
  chunkBudgetMs?: number;
  /** 注入时钟，默认 performance.now()（worker / 浏览器 / Node 均可用）。 */
  now?: () => number;
  /** 注入事件循环让出函数，默认走 MessageChannel（setTimeout 降级）。 */
  yieldFn?: () => Promise<void>;
}

interface OverlapKey {
  key: string;
  ruleAId: string;
  ruleBId: string;
}

/**
 * 把规则空间分析拆成有序叶子（合法取值组合）上的归约。
 * 叶子的访问顺序由字段顺序与候选值顺序唯一确定；快照只记录已访问叶子的偏移量，
 * 所以无论分多少段执行，也无论是否从快照恢复，最终归约结果与 analyzeRules 完全一致。
 */
export class AnalysisRunner {
  private readonly candidates: ScalarCandidate[][];
  private readonly ordered: BusinessRule[];
  private totalCases: number;
  private readonly chunkLeaves: number;
  private readonly now: () => number;
  private readonly chunkBudgetMs: number;
  private readonly yieldFn: () => Promise<void>;

  private offset = 0;
  private checkedCases = 0;
  private coveredCases = 0;
  private truncated = false;
  private readonly seen = new Set<string>();
  private readonly visible = new Set<string>();
  private readonly uncoveredExamples: SampleInput[] = [];
  /** 保留插入顺序：与一次跑完时 overlaps 的生成顺序一致。 */
  private readonly overlaps = new Map<string, RuleOverlap>();
  private readonly resumed: boolean;

  constructor(
    private readonly project: RuleProject,
    checkpoint?: AnalysisCheckpoint | null,
    pacing: AnalysisPacing = {},
  ) {
    this.candidates = project.fields.map((field) => valuesForField(field, project));
    this.ordered = [...project.rules].sort(
      (a, b) => b.priority - a.priority || project.rules.indexOf(a) - project.rules.indexOf(b),
    );
    this.totalCases = countTotalCases(this.candidates);
    this.chunkLeaves = pacing.chunkLeaves ?? DEFAULT_CHUNK_LEAVES;
    this.chunkBudgetMs = pacing.chunkBudgetMs ?? DEFAULT_CHUNK_BUDGET_MS;
    this.now = pacing.now ?? (() => performance.now());
    this.yieldFn = pacing.yieldFn ?? yieldToEventLoop;

    if (checkpoint && checkpoint.signature === computeProjectSignature(project) && checkpoint.version === CHECKPOINT_VERSION) {
      this.offset = checkpoint.offset;
      this.checkedCases = checkpoint.checkedCases;
      this.coveredCases = checkpoint.coveredCases;
      this.truncated = checkpoint.truncated;
      // 沿用快照记录的总叶子数：它可能是 MAX_CASES+1（超限溢出值），
      // 若重新 countTotalCases 理论上结果相同，但直接信任快照更稳妥。
      this.totalCases = checkpoint.totalCases;
      checkpoint.seen.forEach((id) => this.seen.add(id));
      checkpoint.visible.forEach((id) => this.visible.add(id));
      this.uncoveredExamples.push(...cloneExamples(checkpoint.uncoveredExamples));
      for (const overlap of checkpoint.overlaps) {
        this.overlaps.set([overlap.ruleAId, overlap.ruleBId].sort().join('|'), cloneOverlap(overlap));
      }
      this.resumed = true;
    } else {
      this.resumed = false;
    }
  }

  get isDone(): boolean {
    return this.totalCases === 0 || this.truncated || this.offset >= this.totalCases;
  }

  get isResumed(): boolean {
    return this.resumed;
  }

  /**
   * 执行一个分块：在叶子数量或时间预算耗尽时返回，并让出事件循环。
   * 每个叶子只访问一次，所有计数与集合归约都是幂等可交换的，故分段执行不改变结论。
   */
  async runChunk(): Promise<number> {
    const processed = this.processChunk(this.chunkLeaves, this.chunkBudgetMs);
    await this.yieldFn();
    return processed;
  }

  /** 一次性同步跑完所有叶子（保留给纯函数入口与测试）。 */
  runSynchronously(): void {
    this.processChunk(Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY);
  }

  /** 分块核心：在叶子数量或时间预算耗尽时停止。纯归约，不做异步让出。 */
  private processChunk(leafBudget: number, budgetMs: number): number {
    if (this.isDone) return 0;
    const deadline = this.now() + budgetMs;
    let processedThisChunk = 0;
    // 深度优先按“混合进制序号”推进：第 i 位的基数是该字段候选值数量。
    while (processedThisChunk < leafBudget && !this.isDone && this.now() <= deadline) {
      if (this.checkedCases >= MAX_CASES) {
        this.truncated = true;
        break;
      }
      const values = this.valuesAt(this.offset);
      this.visitLeaf(values);
      this.offset += 1;
      processedThisChunk += 1;
    }
    return processedThisChunk;
  }

  getProgress(): AnalysisProgress {
    const planned = Math.min(this.totalCases, MAX_CASES);
    const processed = Math.min(this.offset, planned);
    const percent = planned === 0 ? 100 : Math.min(100, Math.floor((processed / planned) * 100));
    const stage = this.describeStage();
    return {
      processed,
      total: planned,
      percent,
      stageLabel: stage.label,
      stageSegment: stage.segment,
      stageTotal: stage.total,
      resumed: this.resumed,
      truncated: this.totalCases > MAX_CASES,
    };
  }

  checkpoint(): AnalysisCheckpoint {
    return {
      version: CHECKPOINT_VERSION,
      signature: computeProjectSignature(this.project),
      offset: this.offset,
      checkedCases: this.checkedCases,
      coveredCases: this.coveredCases,
      truncated: this.truncated,
      seen: [...this.seen],
      visible: [...this.visible],
      uncoveredExamples: cloneExamples(this.uncoveredExamples),
      overlaps: [...this.overlaps.values()].map(cloneOverlap),
      totalCases: this.totalCases,
    };
  }

  result(): RuleAnalysis {
    const unreachableRuleIds = this.project.rules.filter((rule) => !this.seen.has(rule.id)).map((rule) => rule.id);
    const shadowedRuleIds = this.project.rules
      .filter((rule) => this.seen.has(rule.id) && !this.visible.has(rule.id))
      .map((rule) => rule.id);
    return {
      checkedCases: this.checkedCases,
      coveredCases: this.coveredCases,
      coveragePercent: this.checkedCases ? Math.round((this.coveredCases / this.checkedCases) * 100) : 0,
      overlaps: [...this.overlaps.values()],
      unreachableRuleIds,
      shadowedRuleIds,
      uncoveredExamples: cloneExamples(this.uncoveredExamples),
      truncated: this.truncated,
    };
  }

  /** 原递归 visit 的叶子部分：单个合法取值组合上的全部归约。 */
  private visitLeaf(values: SampleInput): void {
    this.checkedCases += 1;
    const matched = this.ordered.filter((rule) => matchesRule(rule, values));
    for (const rule of matched) this.seen.add(rule.id);
    if (matched.length) this.coveredCases += 1;
    else if (this.uncoveredExamples.length < MAX_EXAMPLES) this.uncoveredExamples.push({ ...values });
    if (matched[0]) this.visible.add(matched[0].id);
    if (matched.length > 1) {
      for (let left = 0; left < matched.length; left += 1) {
        for (let right = left + 1; right < matched.length; right += 1) {
          const ruleA = matched[left];
          const ruleB = matched[right];
          // 去重键排序保证同一对只记一次；但暴露的 id 保持 matched 中的首见顺序，与一次跑完一致。
          if (!this.overlaps.has(overlapKey(ruleA.id, ruleB.id).key)) {
            this.overlaps.set(overlapKey(ruleA.id, ruleB.id).key, {
              ruleAId: ruleA.id,
              ruleBId: ruleB.id,
              conflict: ruleA.priority === ruleB.priority && ruleA.result !== ruleB.result,
              witness: { ...values },
            });
          }
        }
      }
    }
  }

  /** 把线性偏移解码为该叶子的取值；偏移顺序与原递归 DFS 完全相同。 */
  private valuesAt(index: number): SampleInput {
    const values: SampleInput = {};
    let remainder = index;
    for (let fieldIndex = this.candidates.length - 1; fieldIndex >= 0; fieldIndex -= 1) {
      const options = this.candidates[fieldIndex];
      const choice = options.length ? remainder % options.length : 0;
      if (options.length) remainder = Math.floor(remainder / options.length);
      values[this.project.fields[fieldIndex].id] = options[choice];
    }
    return values;
  }

  /** 描述当前处理到“哪个字段维度的第几段”，让进度可观察而不只是百分比。 */
  private describeStage(): { label?: string; segment: number; total: number } {
    if (!this.candidates.length) return { segment: 1, total: 1 };
    // 最外层字段每前进一个候选值，内层字段完整遍历一轮；步长是其余字段候选数之积。
    let stride = 1;
    for (let fieldIndex = 1; fieldIndex < this.candidates.length; fieldIndex += 1) {
      stride *= Math.max(1, this.candidates[fieldIndex].length);
    }
    const outer = this.candidates[0];
    const total = Math.max(1, outer.length);
    // 完成后把阶段定格在最后一段，保证末帧仍能展示处理维度。
    const offsetForStage = this.isDone ? Math.max(0, this.totalCases - 1) : this.offset;
    const segment = Math.min(total, Math.floor(offsetForStage / Math.max(1, stride)) + 1);
    return { label: this.project.fields[0].name, segment, total };
  }
}

export function analyzeRules(project: RuleProject): RuleAnalysis {
  // 同步入口：不经过异步分块/让出，在一个任务内跑完全部叶子，行为与旧递归实现一致。
  const runner = new AnalysisRunner(project, null, { chunkBudgetMs: Number.POSITIVE_INFINITY });
  runner.runSynchronously();
  return runner.result();
}

/**
 * 项目分析签名：只对影响分析结论的内容（字段、规则、字段顺序、规则顺序）敏感，
 * 与 title / updatedAt / 版本记录无关。内容一变签名即变，旧快照自然失效。
 */
export function computeProjectSignature(project: RuleProject): string {
  const payload = JSON.stringify({
    f: project.fields.map((field) => [field.id, field.type, field.min ?? null, field.max ?? null, field.enumValues ?? null]),
    r: project.rules.map((rule) => [rule.id, rule.priority, rule.result, rule.conditions]),
  });
  return `${CHECKPOINT_VERSION}.${fnv1aHex(payload)}.${payload.length}`;
}

function overlapKey(leftId: string, rightId: string): OverlapKey {
  const [ruleAId, ruleBId] = [leftId, rightId].sort();
  return { key: `${ruleAId}|${ruleBId}`, ruleAId, ruleBId };
}

function countTotalCases(candidates: ScalarCandidate[][]): number {
  // 与原递归一致：没有字段时也存在一个“空取值”叶子。
  if (candidates.length === 0) return 1;
  let total = 1;
  for (const options of candidates) {
    if (options.length === 0) return 0;
    total *= options.length;
    if (total > MAX_CASES) return MAX_CASES + 1;
  }
  return total;
}

function cloneExamples(examples: SampleInput[]): SampleInput[] {
  return examples.map((example) => ({ ...example }));
}

function cloneOverlap(overlap: RuleOverlap): RuleOverlap {
  return { ...overlap, witness: { ...overlap.witness } };
}

function yieldToEventLoop(): Promise<void> {
  // MessageChannel 宏任务比 setTimeout(0) 及时得多；受限环境下降级即可。
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** FNV-1a 32bit：短十六进制摘要，仅用于本地快照失效判断。 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // 等价于乘以 FNV 素数后取模 2^32。
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

type ScalarCandidate = string | number | boolean;

function valuesForField(field: RuleField, project: RuleProject): ScalarCandidate[] {
  if (field.type === 'boolean') return [false, true];
  if (field.type === 'enum') return field.enumValues ?? [];
  const min = field.min ?? 0;
  const max = field.max ?? min;
  const breaks = new Set<number>([min, max]);
  for (const rule of project.rules) collectBreaks(rule.conditions, field.id, min, max, breaks);
  const sorted = [...breaks].sort((a, b) => a - b);
  const values = new Set<number>(sorted);
  for (let index = 0; index < sorted.length - 1; index += 1) {
    values.add(sorted[index] + (sorted[index + 1] - sorted[index]) / 2);
  }
  return [...values].sort((a, b) => a - b);
}

function collectBreaks(
  condition: RuleCondition,
  fieldId: string,
  min: number,
  max: number,
  breaks: Set<number>,
): void {
  if (condition.kind === 'group') {
    condition.conditions.forEach((child) => collectBreaks(child, fieldId, min, max, breaks));
    return;
  }
  if (condition.fieldId !== fieldId) return;
  let boundaries: number[];
  if (typeof condition.value === 'number') boundaries = [condition.value];
  else if (typeof condition.value === 'object' && condition.value !== null && 'min' in condition.value && 'max' in condition.value) boundaries = [condition.value.min, condition.value.max];
  else return;
  for (const value of boundaries) if (value >= min && value <= max) breaks.add(value);
}

export const ruleAnalysisService = { analyze: analyzeRules };

export function firstOverlapWitness(analysis: RuleAnalysis) {
  const overlap = analysis.overlaps[0];
  return overlap ? { values: overlap.witness, ruleIds: [overlap.ruleAId, overlap.ruleBId] } : undefined;
}
