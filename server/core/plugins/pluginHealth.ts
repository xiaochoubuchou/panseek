import { loggers } from "../utils/logger";

/** 插件健康状态接口 */
export interface PluginHealthStatus {
  name: string;
  /** 是否允许参与正常搜索调度；熔断冷却期内为 false */
  isHealthy: boolean;
  /** 平均响应时间（毫秒） */
  avgResponseTime: number;
  /** 累计失败次数，供统计使用 */
  failureCount: number;
  /** 累计成功次数，供统计使用 */
  successCount: number;
  /** 连续失败次数；成功后清零 */
  consecutiveFailureCount?: number;
  /** 平均响应时间是否超过阈值；慢速不等于熔断 */
  isSlow?: boolean;
  lastFailureTime?: number;
  lastSuccessTime?: number;
}

/** 插件健康检查配置 */
export interface PluginHealthConfig {
  /** 连续失败达到该次数后触发熔断 */
  maxFailures: number;
  /** 熔断冷却时间（毫秒） */
  circuitBreakerTimeoutMs: number;
  /** 平均响应时间超过该值时标记为慢速（毫秒） */
  responseTimeThresholdMs: number;
}

function createInitialStatus(pluginName: string): PluginHealthStatus {
  return {
    name: pluginName,
    isHealthy: true,
    avgResponseTime: 0,
    failureCount: 0,
    successCount: 0,
    consecutiveFailureCount: 0,
    isSlow: false,
  };
}

/**
 * 插件健康检查器。
 * - failureCount / successCount 是累计统计，不因恢复而清零。
 * - consecutiveFailureCount 只统计连续失败，成功后清零。
 * - 慢速插件仍可参与搜索，不会仅因响应慢而被熔断。
 * - 熔断冷却期结束后，isHealthy() 允许插件重新参与请求；
 *   后续请求成功则恢复，失败则重新累计连续失败次数。
 *
 * 注意：该 Map 是 Worker 实例内存状态，不是跨实例持久化统计。
 */
export class PluginHealthChecker {
  private healthMap = new Map<string, PluginHealthStatus>();
  private config: PluginHealthConfig;

  constructor(config: PluginHealthConfig) {
    this.config = {
      ...config,
      maxFailures: Math.max(1, Math.floor(config.maxFailures || 1)),
      circuitBreakerTimeoutMs: Math.max(0, config.circuitBreakerTimeoutMs || 0),
      responseTimeThresholdMs: Math.max(0, config.responseTimeThresholdMs || 0),
    };
  }

  recordSuccess(pluginName: string, responseTimeMs: number): void {
    const current = this.healthMap.get(pluginName) || createInitialStatus(pluginName);
    const safeResponseTime = Number.isFinite(responseTimeMs)
      ? Math.max(0, responseTimeMs)
      : 0;

    current.successCount += 1;
    current.lastSuccessTime = Date.now();
    current.consecutiveFailureCount = 0;

    // 累计平均值，避免每次请求都保存完整响应时间样本。
    current.avgResponseTime +=
      (safeResponseTime - current.avgResponseTime) / current.successCount;

    current.isSlow =
      this.config.responseTimeThresholdMs > 0 &&
      current.avgResponseTime > this.config.responseTimeThresholdMs;

    if (!current.isHealthy) {
      current.isHealthy = true;
      loggers.plugin.info("插件恢复正常", {
        plugin: pluginName,
        afterMs: current.lastFailureTime
          ? Date.now() - current.lastFailureTime
          : undefined,
      });
    }

    this.healthMap.set(pluginName, current);
  }

  recordFailure(pluginName: string): void {
    const current = this.healthMap.get(pluginName) || createInitialStatus(pluginName);

    current.failureCount += 1;
    current.consecutiveFailureCount += 1;
    current.lastFailureTime = Date.now();

    if (
      current.consecutiveFailureCount >= this.config.maxFailures &&
      current.isHealthy
    ) {
      current.isHealthy = false;
      loggers.plugin.warn("插件触发熔断", {
        plugin: pluginName,
        failureCount: current.failureCount,
        consecutiveFailureCount: current.consecutiveFailureCount,
        maxFailures: this.config.maxFailures,
        breakerTimeoutMs: this.config.circuitBreakerTimeoutMs,
      });
    }

    this.healthMap.set(pluginName, current);
  }

  isHealthy(pluginName: string): boolean {
    const status = this.healthMap.get(pluginName);
    if (!status) return true;

    if (!status.isHealthy && status.lastFailureTime !== undefined) {
      const timeSinceLastFailure = Date.now() - status.lastFailureTime;
      if (timeSinceLastFailure >= this.config.circuitBreakerTimeoutMs) {
        status.isHealthy = true;
        status.consecutiveFailureCount = 0;
        this.healthMap.set(pluginName, status);
        loggers.plugin.info("插件熔断冷却结束，允许重新尝试", {
          plugin: pluginName,
          afterMs: timeSinceLastFailure,
        });
      }
    }

    return status.isHealthy;
  }

  getStatus(pluginName: string): PluginHealthStatus | undefined {
    const status = this.healthMap.get(pluginName);
    return status ? { ...status } : undefined;
  }

  getAllStatus(): PluginHealthStatus[] {
    return Array.from(this.healthMap.values(), (status) => ({ ...status }));
  }

  reset(pluginName: string): void {
    this.healthMap.delete(pluginName);
  }

  resetAll(): void {
    this.healthMap.clear();
  }
}

/** 创建默认的插件健康检查器 */
export function createPluginHealthChecker(): PluginHealthChecker {
  return new PluginHealthChecker({
    maxFailures: 5,
    circuitBreakerTimeoutMs: 5 * 60 * 1000,
    responseTimeThresholdMs: 10 * 1000,
  });
}
