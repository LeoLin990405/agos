/**
 * 新会话请求:rail / ⌘K / 顶栏共用。ChatPage 才拿得到弹窗 state,
 * 所以用一次待消费标记 + CustomEvent,避免「先切到对话页再广播」把事件丢掉。
 */
export const NEW_SESSION_EVENT = 'agos:new-session';

let pending = false;

export function requestNewSession(): void {
  pending = true;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(NEW_SESSION_EVENT));
  }
}

export function consumeNewSessionRequest(): boolean {
  const value = pending;
  pending = false;
  return value;
}
