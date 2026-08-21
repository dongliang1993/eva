import type { RunStreamEvent, RunStreamFrame } from "@eva/shared";
import type { FastifyReply } from "fastify";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no"
} as const;

/** 静默连接的保活间隔 —— 比常见的 60s idle 超时留足余量。 */
const HEARTBEAT_MS = 15_000;

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
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly reply: FastifyReply) {}

  open(): void {
    this.reply.raw.writeHead(200, SSE_HEADERS);

    // 心跳:大工具可能几分钟不产帧,中间层会把这种静默连接当 idle 掐断。
    // 注释帧对客户端是透明的(parseSSEBuffer 只认 event: / data: 前缀)。
    // unref:这条定时器不该拖着进程/测试进程不退出。
    this.heartbeat = setInterval(() => this.write(": ping\n\n"), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** 写之前统一挡一次死 socket —— 迟到事件不能触发 write-after-end。 */
  private write(chunk: string): boolean {
    if (this.closed || this.reply.raw.writableEnded || this.reply.raw.destroyed) {
      return false;
    }

    this.reply.raw.write(chunk);
    return true;
  }

  emit(event: RunStreamEvent): void {
    // 后台子代理可能在 run 收尾后才产生事件。响应已经关闭时静默丢弃；
    // 事实仍在 DB 中，不能让迟到事件触发 write-after-end。
    if (this.closed || this.reply.raw.writableEnded || this.reply.raw.destroyed) {
      return;
    }

    this.seq += 1;
    const frame = { ...event, seq: this.seq } as RunStreamFrame;
    this.write(formatFrame(frame));
  }

  onDisconnect(listener: () => void): void {
    // Node >=18 的 request "close" 在请求体读完时就可能触发；response "close"
    // 才表示 socket 在 response.end() 前关闭。
    this.reply.raw.on("close", () => {
      if (!this.closed) listener();
    });
  }

  close(): void {
    // 与 emit 同一套守卫:订阅者先断连、run 之后才 closeAll 是常态,
    // 那时 socket 已经死了,end() 会抛 ERR_STREAM_ALREADY_FINISHED。
    if (this.closed || this.reply.raw.writableEnded || this.reply.raw.destroyed) {
      this.stopHeartbeat();
      this.closed = true;
      return;
    }

    this.stopHeartbeat();
    this.closed = true;
    this.reply.raw.end();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}
