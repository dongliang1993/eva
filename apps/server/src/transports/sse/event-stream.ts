import type { RunStreamEvent, RunStreamFrame } from "@eva/shared";
import type { FastifyReply } from "fastify";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no"
} as const;

const formatFrame = (frame: RunStreamFrame): string =>
  `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;

/**
 * 一次 run 的 SSE 传输通道。
 *
 * 只负责 HTTP/SSE 语义：响应头、单调 seq、帧编码、断连检测和安全关闭。
 * abort run、取消审批等业务反应由 route 通过 onDisconnect 注册，避免传输层
 * 反向依赖 services。
 */
export class RunEventStream {
  private seq = 0;
  private closed = false;

  constructor(private readonly reply: FastifyReply) {}

  open(): void {
    this.reply.raw.writeHead(200, SSE_HEADERS);
  }

  emit(event: RunStreamEvent): void {
    // 后台子代理可能在 run 收尾后才产生事件。响应已经关闭时静默丢弃；
    // 事实仍在 DB 中，不能让迟到事件触发 write-after-end。
    if (this.closed || this.reply.raw.writableEnded || this.reply.raw.destroyed) {
      return;
    }

    this.seq += 1;
    const frame = { ...event, seq: this.seq } as RunStreamFrame;
    this.reply.raw.write(formatFrame(frame));
  }

  onDisconnect(listener: () => void): void {
    // Node >=18 的 request "close" 在请求体读完时就可能触发；response "close"
    // 才表示 socket 在 response.end() 前关闭。
    this.reply.raw.on("close", () => {
      if (!this.closed) listener();
    });
  }

  close(): void {
    if (this.closed) return;

    this.closed = true;
    this.reply.raw.end();
  }
}
