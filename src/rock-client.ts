import type {
  ConnectionEvent,
  ConnectionState,
  IncomingPacket,
  JsonValue,
  OutgoingPacket,
  RequestOptions,
  RockClientOptions,
  SignalPayload,
  RpcParams,
  RpcResponse,
} from "./types.js";

type Listener<T> = (value: T) => void;
type PendingRequest = {
  response: string;
  resolve: (value: SignalPayload) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const requestId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export class RockClient {
  private readonly options: Required<
    Pick<RockClientOptions, "requestTimeoutMs">
  > &
    RockClientOptions;
  private readonly WebSocketImpl: typeof WebSocket;
  private socket?: WebSocket;
  private state: ConnectionState = "idle";
  private attempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private manuallyClosed = false;
  private listeners = new Map<string, Set<Listener<unknown>>>();
  private pending = new Map<string, PendingRequest>();

  constructor(options: RockClientOptions) {
    this.options = { requestTimeoutMs: 15_000, ...options };
    this.WebSocketImpl = options.WebSocket ?? WebSocket;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }
  get connected(): boolean {
    return this.state === "open";
  }

  connect(): void {
    if (
      this.state === "open" ||
      this.state === "connecting" ||
      this.state === "reconnecting"
    )
      return;
    this.manuallyClosed = false;
    this.open();
  }

  close(code?: number, reason?: string): void {
    this.manuallyClosed = true;
    this.clearReconnect();
    this.rejectPending(new Error("ROCK client closed"));
    this.setState("closed");
    this.socket?.close(code, reason);
    this.socket = undefined;
  }
  disconnect = this.close.bind(this);

  on<T = unknown>(event: string, listener: Listener<T>): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as Listener<unknown>);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(listener as Listener<unknown>);
      if (!listeners.size) this.listeners.delete(event);
    };
  }

  onSignal<T extends SignalPayload = SignalPayload>(
    name: string,
    listener: Listener<T>,
  ): () => void {
    return this.on(`signal:${name}`, listener);
  }

  sendSignal(name: string, data: SignalPayload = null): boolean {
    return this.send({ t: "signal", d: { name, data } });
  }
  sendInput(id: number, data: JsonValue): boolean {
    return this.send({ t: "input", d: { id, data } });
  }

  request<T = unknown>(
    name: string,
    data: RpcParams = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const id = requestId();
    const response = options.response ?? name;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
    const unwrap = options.unwrap ?? true;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ROCK request timed out: ${name}`));
      }, timeoutMs);
      this.pending.set(id, {
        response,
        timer,
        reject,
        resolve: (payload) =>
          resolve((unwrap ? unwrapResponse(payload) : payload) as T),
      });
      if (!this.sendSignal(name, { ...data, request_id: id })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("ROCK socket is not open"));
      }
    });
  }

  private open(): void {
    this.setState(this.attempt ? "reconnecting" : "connecting");
    const url =
      typeof this.options.url === "function"
        ? this.options.url()
        : this.options.url;
    const ws = new this.WebSocketImpl(url, this.options.protocols);
    this.socket = ws;
    ws.addEventListener("open", () => {
      this.attempt = 0;
      this.setState("open");
    });
    ws.addEventListener("message", (event) => this.receive(event));
    ws.addEventListener("error", () =>
      this.emit("error", new Error("ROCK WebSocket error")),
    );
    ws.addEventListener("close", (event) => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.emit("close", event);
      this.rejectPending(new Error("ROCK connection closed"));
      this.scheduleReconnect(event);
    });
  }

  private receive(event: MessageEvent): void {
    let packet: IncomingPacket;
    try {
      packet = JSON.parse(String(event.data)) as IncomingPacket;
    } catch {
      this.emit("error", new Error("Invalid ROCK packet"));
      return;
    }
    this.emit("packet", packet);
    if (packet.t !== "signal") return;
    const signal = packet.d;
    this.emit("signal", signal);
    this.emit(`signal:${signal.name}`, signal.data);
    const id = readRequestId(signal.data);
    const pending = id ? this.pending.get(id) : undefined;
    if (!pending || pending.response !== signal.name) return;
    clearTimeout(pending.timer);
    this.pending.delete(id!);
    if (isRpcResponse(signal.data) && signal.data.ok === false)
      pending.reject(
        new Error(
          String(
            signal.data.error ?? "ROCK request failed",
          ),
        ),
      );
    else pending.resolve(signal.data);
  }

  private send(packet: OutgoingPacket): boolean {
    if (this.socket?.readyState !== this.WebSocketImpl.OPEN) return false;
    this.socket.send(JSON.stringify(packet));
    return true;
  }
  private scheduleReconnect(event: CloseEvent): void {
    if (this.manuallyClosed || this.options.reconnect?.enabled === false) {
      this.setState("closed", event);
      return;
    }
    const reconnect = this.options.reconnect ?? {};
    const min = reconnect.minDelayMs ?? 500,
      max = reconnect.maxDelayMs ?? 15_000,
      factor = reconnect.factor ?? 2,
      jitter = reconnect.jitter ?? 0.2;
    const base = Math.min(max, min * factor ** this.attempt++);
    const delay = base * (1 - jitter + Math.random() * jitter * 2);
    this.setState("reconnecting", event);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }
  private setState(state: ConnectionState, event?: CloseEvent): void {
    this.state = state;
    this.emit("connection", {
      state,
      attempt: this.attempt,
      event,
    } satisfies ConnectionEvent);
  }
  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  private emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

export const createRockClient = (options: RockClientOptions) =>
  new RockClient(options);
const isObject = (value: JsonValue): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const readRequestId = (data: SignalPayload): string | undefined =>
  isObject(data) && typeof data.request_id === "string" ? data.request_id : undefined;
const isRpcResponse = (
  data: SignalPayload,
): data is RpcResponse & Record<string, JsonValue> =>
  isObject(data) && typeof data.request_id === "string";
const unwrapResponse = (payload: SignalPayload): SignalPayload =>
  isRpcResponse(payload) && "data" in payload ? payload.data ?? null : payload;
