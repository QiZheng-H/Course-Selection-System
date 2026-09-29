/**
 * 幂等键：同一次用户意图重复提交（例如失败后重试）必须复用同一个 key。
 * 用法：组件里 `const key = ref(newIdempotencyKey())`，成功后再 `key.value = newIdempotencyKey()`。
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
