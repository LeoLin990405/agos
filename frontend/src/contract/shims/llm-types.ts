/**
 * Shim for @deepseek-ai/dsh-llm/types(P0 宽松版:只承载契约层的类型位。
 * P1 vendor fold 时换成上游真实定义)。
 */
export type ContentBlock = { type: string } & Record<string, unknown>
export type Message = { role: string; content: unknown } & Record<string, unknown>
