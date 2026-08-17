/**
 * A single streamed event as emitted by the server over SSE.
 * Every frame carries a monotonic `seq` so the renderer can reorder
 * out-of-order / dedupe duplicate frames (first red line, 01 §7 / 10 §6).
 */
export interface StreamEvent {
  readonly seq: number;
  readonly type: string;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  readonly [key: string]: any;
}