/** Shim for @deepseek-ai/dsh-brand —— 与上游同形的名义类型原语(纯类型,零运行时代码)。 */
declare const BRAND: unique symbol
export type Branded<B extends string> = string & { readonly [BRAND]: B }
