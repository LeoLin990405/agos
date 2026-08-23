/**
 * MediaBlocks —— W2 输出侧渲染:工具结果 / 用户消息里的图片与音频。
 *
 * 取件通道(全部真实,无编造):
 * - attachment 引用 → session.attachment RPC(契约方法,证明会话日志引用过该 id)
 *   RPC 拿不到(归档会话不在宿主名册等)→ W19 回退 GET /api/cn/media?attachmentId=(服务端拼 object 路径 + 魔数嗅探),只对图片
 * - 宿主机路径 → GET /api/cn/media?path=(三道闸只读路由)
 * - 远程 URL → 原样使用
 * 加载失败显示错误条(保留名称),绝不静默吞。
 */
import React, { useEffect, useState } from 'react';
import { Dot } from '@/components/ui/Dot';
import { agos } from '@/stores/live';
import { mediaObjectUrl, mediaRouteUrl, type MediaRef } from './media-blocks';
import '@/design-system/media-blocks.css';

/** attachment → data URL(session.attachment 的 data 是未加前缀的 base64)。 */
function useAttachmentDataUrl(
  sessionId: string | undefined,
  attachmentId: string | undefined,
  mediaType: string | undefined,
  kind: MediaRef['kind'],
): { url: string | undefined; error: string | undefined; loading: boolean; via: 'rpc' | 'object-store' | undefined } {
  type S = { url: string | undefined; error: string | undefined; loading: boolean; via: 'rpc' | 'object-store' | undefined };
  const [state, setState] = useState<S>({ url: undefined, error: undefined, loading: attachmentId !== undefined, via: undefined });
  useEffect(() => {
    // W19 回退:RPC 失败(归档会话不在宿主名册 / 无会话上下文)时,图片改走 object store 路由;
    // 音频不回退(object store 里没有音频,服务端也不嗅音频)。
    const fallback = (reason: string): S => {
      const objectUrl = kind === 'image' && attachmentId !== undefined ? mediaObjectUrl(attachmentId, mediaType) : undefined;
      return objectUrl !== undefined
        ? { url: objectUrl, loading: false, error: undefined, via: 'object-store' }
        : { url: undefined, loading: false, error: reason, via: undefined };
    };
    if (attachmentId === undefined) { setState({ url: undefined, loading: false, error: undefined, via: undefined }); return undefined; }
    if (sessionId === undefined) { setState(fallback('无会话上下文')); return undefined; }
    let alive = true;
    setState({ url: undefined, error: undefined, loading: true, via: undefined });
    agos.call('session.attachment', { sessionId: sessionId as never, attachmentId: attachmentId as never })
      .then((res) => {
        if (!alive) return;
        if (!res.result.ok) { setState(fallback(res.result.error.message)); return; }
        const mime = res.result.value.attachment.mediaType ?? mediaType ?? 'application/octet-stream';
        setState({ loading: false, error: undefined, url: `data:${mime};base64,${res.result.value.data}`, via: 'rpc' });
      })
      .catch((error: unknown) => {
        if (alive) setState(fallback(error instanceof Error ? error.message : String(error)));
      });
    return () => { alive = false; };
  }, [attachmentId, sessionId, mediaType, kind]);
  return state;
}

const MediaFigure: React.FC<{
  media: MediaRef;
  sessionId: string | undefined;
  onZoom?: (media: MediaRef, url: string) => void;
}> = ({ media, sessionId, onZoom }) => {
  const attachment = useAttachmentDataUrl(
    sessionId,
    media.attachmentId,
    media.mediaType,
    media.kind,
  );
  const src = media.path !== undefined
    ? mediaRouteUrl(media.path)
    : media.url !== undefined
      ? media.url
      : attachment.url;

  if (media.attachmentId !== undefined && attachment.loading) {
    return (
      <div className="mb-item mb-loading" aria-label={`加载 ${media.name ?? '媒体'}`}>
        <Dot state="running" size={6} />
        <span>{media.name ?? '媒体加载中…'}</span>
      </div>
    );
  }
  if (src === undefined || attachment.error !== undefined) {
    return (
      <div className="mb-item mb-error" role="alert">
        取不到{media.name ?? (media.kind === 'audio' ? '音频' : '图片')}
        {attachment.error !== undefined ? `:${attachment.error}` : ''}
      </div>
    );
  }

  if (media.kind === 'audio') {
    return (
      <div className="mb-item mb-audio">
        <audio controls preload="none" src={src} aria-label={media.name ?? '音频'} />
        {media.name !== undefined && <span className="mb-caption u-num">{media.name}</span>}
      </div>
    );
  }
  return (
    <figure className="mb-item mb-image">
      <button
        type="button"
        className="mb-thumb"
        onClick={() => onZoom?.(media, src)}
        title={media.name !== undefined ? `放大 ${media.name}` : '放大图片'}
        aria-label={media.name !== undefined ? `放大 ${media.name}` : '放大图片'}
      >
        <img
          src={src}
          alt={media.name ?? '工具产出的图片'}
          loading="lazy"
          width={media.width}
          height={media.height}
        />
      </button>
      {media.name !== undefined && <figcaption className="mb-caption u-num">{media.name}</figcaption>}
      {attachment.via === 'object-store' && <figcaption className="mb-caption u-num" data-media-via="object-store">经 object store 取件（会话附件 RPC 不可用）</figcaption>}
    </figure>
  );
};

export const MediaBlocks: React.FC<{
  refs: readonly MediaRef[];
  sessionId?: string | undefined;
}> = ({ refs, sessionId }) => {
  const [zoomed, setZoomed] = useState<{ media: MediaRef; url: string } | undefined>();
  if (refs.length === 0) return null;
  return (
    <>
      <div className="mb-strip" aria-label={`媒体 ${refs.length} 项`}>
        {refs.map((media) => (
          <MediaFigure key={media.key} media={media} sessionId={sessionId} onZoom={(m, url) => setZoomed({ media: m, url })} />
        ))}
      </div>
      {zoomed !== undefined && (
        <div
          className="mb-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={zoomed.media.name ?? '图片放大'}
          onClick={() => setZoomed(undefined)}
        >
          <img src={zoomed.url} alt={zoomed.media.name ?? '放大的图片'} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </>
  );
};
