/**
 * @fileoverview IClusterMembershipTransition — Joint Consensus 安全成员变更接口
 *
 * 实现 Raft 论文 §6 描述的 Joint Consensus 两阶段成员变更：
 *   C_old → C_old_new (Joint) → C_new
 *
 * 核心安全保证：
 *   1. 任何时候至多一个活跃配置（C_old / C_old_new / C_new）
 *   2. Joint 阶段需要 C_old 和 C_new 双 majority 才能 commit
 *   3. C_new 阶段只需要 C_new 的 majority
 *   4. 不支持从 C_old 直接切换到 C_new（防止脑裂）
 *
 * 与 RaftGroup.proposeMembershipChange 的关系：
 *   - RaftGroup 提供底层日志条目写入（propose）
 *   - IClusterMembershipTransition 提供上层编排（重试、回滚、超时、事件）
 *   - 此接口在 RaftGroupManager 层级聚合，提供跨分片协调
 */

import type { MembershipChange, RaftConsensusPhase } from '../../interfaces/types';

/** Peer 配置 */
export interface PeerConfig {
  /** 节点唯一标识 */
  id: string;
  /** 节点地址 */
  host: string;
  /** 节点端口 */
  port: number;
  /** 角色：voter（投票成员） 或 learner（非投票成员） */
  role: 'voter' | 'learner';
  /** 选举优先级（仅 voter 有效） */
  priority?: number;
  /** 节点所在区域（用于拓扑感知） */
  region?: string;
  /** 节点所在可用区 */
  zone?: string;
}

/** 当前过渡阶段 */
export type TransitionPhase = 'stable' | 'joint' | 'new';

/** 成员变更结果 */
export interface TransitionResult {
  /** 是否成功 */
  success: boolean;
  /** 错误信息（失败时） */
  error?: string;
  /** 旧配置 */
  oldConfig: PeerConfig[];
  /** 新配置 */
  newConfig: PeerConfig[];
  /** Joint 阶段配置（C_old ∪ C_new） */
  jointConfig: PeerConfig[];
  /** 最终提交的阶段 */
  committedStep: 'old' | 'joint' | 'new' | 'none';
  /** 耗时（ms） */
  duration: number;
  /** 变更后的活跃阶段 */
  phase: Exclude<TransitionPhase, 'stable' | 'new'> | 'stable';
}

/** 成员变更事件 */
export interface MembershipChangeEvent {
  type: 'transition_started' | 'joint_committed' | 'new_committed' | 'transition_aborted' | 'transition_failed';
  changeId: string;
  oldConfig: PeerConfig[];
  newConfig: PeerConfig[];
  phase: TransitionPhase;
  timestamp: number;
  error?: string;
}

/** 变更进度报告 */
export interface TransitionProgress {
  changeId: string;
  phase: TransitionPhase;
  /** Joint 阶段的 ack 数量 */
  jointAcks: { oldMajority: number; oldAcks: number; newMajority: number; newAcks: number };
  /** 是否已超时 */
  isTimedOut: boolean;
  /** 经过时间 (ms) */
  elapsed: number;
  /** 预定超时时间 (ms) */
  timeoutMs: number;
}

/** 变更选项 */
export interface TransitionOptions {
  /** 超时时间 (ms)，默认 30_000 */
  timeoutMs?: number;
  /** 重试次数，默认 10 */
  maxRetries?: number;
  /** 重试基时间 (ms)，默认 200 */
  retryBaseMs?: number;
  /** 是否自动触发选举（加入新节点后） */
  autoCampaign?: boolean;
  /** 变更标识符 */
  changeId?: string;
}

/**
 * IClusterMembershipTransition — Joint Consensus 安全成员变更
 *
 * 职责边界：
 *   - 只负责成员变更的编排（不负责 Raft 核心日志复制）
 *   - 不负责分片迁移（那是 IOnlineShardMigration 的职责）
 *   - 不负责集群拓扑（那是 IClusterTopology 的职责）
 *
 * 安全性：
 *   使用 Raft Joint Consensus 两阶段提交保证：
 *     - 不允许从 C_old 直接到 C_new
 *     - Joint 阶段使用双 majority
 *     - 超时自动回滚
 */
export interface IClusterMembershipTransition {
  /**
   * 安全地将集群从当前配置过渡到新配置。
   *
   * 过程：
   *   1. 验证变更合法性（不能是单节点集群踢出最后一个节点）
   *   2. 创建 C_old_new (old ∪ new)
   *   3. 以联合 majority 提交 C_old_new 条目
   *   4. 提交 C_new 条目（仅需新配置 majority）
   *   5. 清理过渡状态
   *
   * 线程安全：同一时间只能有一个 transition 在进行
   */
  transitionTo(peers: PeerConfig[], options?: TransitionOptions): Promise<TransitionResult>;

  /**
   * 获取当前过渡阶段
   */
  getTransitionPhase(): TransitionPhase;

  /**
   * 获取当前的 Joint Consensus 配置（如果正在过渡中）
   */
  getActiveTransition(): {
    changeId: string;
    oldConfig: PeerConfig[];
    newConfig: PeerConfig[];
    phase: TransitionPhase;
  } | null;

  /**
   * 获取当前过渡进度
   */
  getProgress(): TransitionProgress | null;

  /**
   * 中止正在进行的过渡。
   * 仅在 C_old_new 尚未提交时安全可用。
   * 如果 C_new 已提交，则不可中止。
   */
  abortTransition(): Promise<TransitionResult>;

  /**
   * 注册过渡事件监听
   */
  onTransitionEvent(handler: (event: MembershipChangeEvent) => void): () => void;
}
