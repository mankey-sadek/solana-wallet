export type EventType = "info" | "swap_detected" | "buy" | "sell" | "skip" | "error" | "position_closed";

export interface LogEvent {
  id: number;
  ts: string;
  type: EventType;
  message: string;
  data?: Record<string, unknown>;
}

const MAX_EVENTS = 300;

class EventLog {
  private events: LogEvent[] = [];
  private nextId = 1;

  add(type: EventType, message: string, data?: Record<string, unknown>): void {
    this.events.push({ id: this.nextId++, ts: new Date().toISOString(), type, message, data });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  recent(limit = 100): LogEvent[] {
    return this.events.slice(-limit).reverse();
  }
}

export const eventLog = new EventLog();
