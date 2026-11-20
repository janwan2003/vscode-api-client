/**
 * Server-sent events (`Content-Type: text/event-stream`), parsed as the HTML standard describes
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation):
 * lines end with CRLF, LF or CR; `field: value` (one leading space dropped); `data` lines join with
 * `\n`; an event is dispatched at a blank line, and only when it has data; `:` lines are comments;
 * `id` persists to later events; `retry` must be all digits. A stream that ends mid-event drops it.
 */
export interface SseEvent {
  /** `event:` field, else "message". */
  event: string;
  data: string;
  /** Last event ID seen so far in the stream (the spec's "last event ID"), when there was one. */
  id?: string;
  retry?: number;
  /** Milliseconds after the request started that the event was complete. */
  timeMs: number;
}

export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private type = '';
  private lastId: string | undefined;
  private retry: number | undefined;
  private sawCr = false;
  private first = true;

  /** Feed decoded text; returns the events completed by it. */
  feed(text: string, timeMs = 0): SseEvent[] {
    if (this.first) {
      this.first = false;
      if (text.startsWith('﻿')) text = text.slice(1);
    }
    // A CR at the end of the previous chunk already ended its line; a LF right after it is part of that CRLF.
    if (this.sawCr && text.startsWith('\n')) text = text.slice(1);
    this.sawCr = false;
    this.buffer += text;
    const out: SseEvent[] = [];
    const re = /\r\n|\r|\n/g;
    let start = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buffer))) {
      // A CR as the last character may be the first half of a CRLF split across chunks: end the line, remember it.
      if (m[0] === '\r' && m.index === this.buffer.length - 1) this.sawCr = true;
      this.line(this.buffer.slice(start, m.index), out, timeMs);
      start = re.lastIndex;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  private line(line: string, out: SseEvent[], timeMs: number): void {
    if (line === '') {
      if (this.data.length) {
        const e: SseEvent = { event: this.type || 'message', data: this.data.join('\n'), timeMs };
        if (this.lastId !== undefined && this.lastId !== '') e.id = this.lastId;
        if (this.retry !== undefined) e.retry = this.retry;
        out.push(e);
      }
      this.data = [];
      this.type = '';
      this.retry = undefined;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.type = value;
    else if (field === 'id') {
      if (!value.includes('\0')) this.lastId = value;
    } else if (field === 'retry') {
      if (/^\d+$/.test(value)) this.retry = Number(value);
    }
  }
}

export function isEventStream(contentType: string | undefined): boolean {
  return /^\s*text\/event-stream\b/i.test(contentType ?? '');
}

/** Events as assertions and the response view see them: `data` parsed as JSON when it is JSON. */
export function eventsView(events: SseEvent[]): { event: string; data: unknown; id?: string; timeMs: number }[] {
  return events.map((e) => {
    let data: unknown = e.data;
    if (/^\s*[[{"\d-]|^\s*(true|false|null)\s*$/.test(e.data)) {
      try {
        data = JSON.parse(e.data);
      } catch {
        /* keep the text */
      }
    }
    return { event: e.event, data, ...(e.id !== undefined ? { id: e.id } : {}), timeMs: e.timeMs };
  });
}
