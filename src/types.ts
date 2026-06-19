export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type SignalData = Record<string, JsonValue>;

export interface RockSignal<T extends SignalData = SignalData> {
  name: string;
  data: T;
}

export type OutgoingPacket =
  | { t: "signal"; d: RockSignal }
  | { t: "input"; d: { id: number; data: JsonValue } };

export type IncomingPacket =
  | { t: "signal"; d: RockSignal }
  | { t: "world"; d: JsonValue }
  | { t: "system"; d: JsonValue };

export type ConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface ReconnectOptions {
  enabled?: boolean;
  minDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: number;
}

export interface RockClientOptions {
  url: string | (() => string);
  protocols?: string | string[];
  reconnect?: ReconnectOptions;
  requestTimeoutMs?: number;
  WebSocket?: typeof WebSocket;
}

export interface RequestOptions {
  response?: string;
  timeoutMs?: number;
  unwrap?: boolean;
}

export interface ConnectionEvent {
  state: ConnectionState;
  attempt: number;
  event?: CloseEvent;
}
