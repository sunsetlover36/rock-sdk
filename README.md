# ROCK TypeScript SDK

TypeScript client SDK for the ROCK runtime WebSocket protocol.

ROCK apps communicate through small JSON packets: signals, inputs, and request/response-style signals. This SDK gives browser clients a thin, typed layer over that protocol: connection lifecycle, reconnects, event subscriptions, request timeouts, and request/response correlation.

```bash
npm install @rock-runtime/sdk
```

## Usage

```ts
import { createRockClient } from "@rock-runtime/sdk";

const rock = createRockClient({
  url: "ws://localhost:3000",
});

rock.on("connection", ({ state }) => {
  console.log("ROCK connection:", state);
});

rock.onSignal("CaveSync", (data) => {
  renderCave(data);
});

rock.connect();

const profile = await rock.request("PeopleProfile", { fid: 3 });

// Close only when the app itself is done.
// Event subscriptions survive reconnects.
rock.close();
```

## What it handles

The SDK owns the boring parts of a ROCK client connection:

* WebSocket connection state
* automatic reconnects
* event listeners with unsubscribe functions
* request IDs
* request timeouts
* request/response matching
* disconnect cleanup
* JSON packet parsing
* signal helpers

## API

### `createRockClient(options)`

Creates a new `RockClient`.

```ts
const rock = createRockClient({
  url: "ws://localhost:3000",
});
```

`url` can be either a string or a function returning a string.

```ts
const rock = createRockClient({
  url: () => `wss://example.com/room/${roomId}`,
});
```

### `connect()`

Opens the WebSocket connection.

```ts
rock.connect();
```

Calling `connect()` while already connected or connecting is safe.

### `close(code?, reason?)`

Closes the connection, stops reconnects, and rejects pending requests.

```ts
rock.close();
```

`disconnect` is also available as an alias.

```ts
rock.disconnect();
```

### `on(event, listener)`

Subscribes to a client event and returns an unsubscribe function.

```ts
const off = rock.on("connection", ({ state }) => {
  console.log(state);
});

off();
```

Common events:

```ts
rock.on("connection", ({ state, attempt, event }) => {});
rock.on("packet", (packet) => {});
rock.on("signal", (signal) => {});
rock.on("error", (error) => {});
rock.on("close", (event) => {});
```

### `onSignal(name, listener)`

Subscribes to a named ROCK signal.

```ts
const off = rock.onSignal("PlayerJoined", (data) => {
  console.log("joined:", data);
});
```

This is shorthand for:

```ts
rock.on("signal:PlayerJoined", listener);
```

### `sendSignal(name, data?)`

Sends a named signal.

```ts
rock.sendSignal("ChatMessage", {
  text: "hello",
});
```

Returns `false` if the socket is not open.

### `sendInput(id, data)`

Sends an input packet.

```ts
rock.sendInput(1, {
  left: true,
  jump: false,
});
```

Returns `false` if the socket is not open.

### `request(name, data?, options?)`

Sends a signal with a generated `request_id` and waits for the matching response signal.

```ts
const profile = await rock.request("PeopleProfile", {
  fid: 3,
});
```

By default, `request()` expects the response signal to have the same name as the request. You can override that:

```ts
const profile = await rock.request(
  "PeopleProfileGet",
  { fid: 3 },
  { response: "PeopleProfile" },
);
```

Requests reject on timeout, disconnect, failed send, or explicit `{ ok: false, error }` response data. A request is a convention between client and gamemode: the response must use the same signal name (or `options.response`) and echo the generated `request_id`.

```ts
try {
  const profile = await rock.request("PeopleProfile", { fid: 3 });
} catch (error) {
  console.error("request failed:", error);
}
```

By default, if the response payload contains a `data` field, the SDK unwraps it:

```ts
// Response signal data (the RPC envelope):
{
  ok: true,
  data: {
    fid: 3,
    username: "alice"
  }
}

// request() resolves to:
{
  fid: 3,
  username: "alice"
}
```

Disable this with `unwrap: false`.

```ts
const raw = await rock.request("PeopleProfile", { fid: 3 }, {
  unwrap: false,
});
```

Regular signal payloads are not RPC envelopes and may be any JSON value (object, array, string, boolean, or `null`). `onSignal()` receives that exact payload. `request()` accepts an object because it has to add `request_id`; it unwraps only the explicit envelope above — never an accidental `data.data` shape.

## Reconnects

Reconnects are enabled by default.

```ts
const rock = createRockClient({
  url: "ws://localhost:3000",
  reconnect: {
    minDelayMs: 500,
    maxDelayMs: 15_000,
    factor: 2,
    jitter: 0.2,
  },
});
```

Disable reconnects:

```ts
const rock = createRockClient({
  url: "ws://localhost:3000",
  reconnect: {
    enabled: false,
  },
});
```

Subscriptions stay registered across reconnects. Pending requests are rejected when the connection closes.

## Request timeouts

Default request timeout is 15 seconds.

```ts
const rock = createRockClient({
  url: "ws://localhost:3000",
  requestTimeoutMs: 15_000,
});
```

Override per request:

```ts
await rock.request("SlowOperation", {}, {
  timeoutMs: 60_000,
});
```

## Browser and server runtimes

The SDK is browser-first and uses the global `WebSocket` by default.

For Node.js or custom runtimes, pass a WebSocket implementation:

```ts
import WebSocket from "ws";
import { createRockClient } from "@rock-runtime/sdk";

const rock = createRockClient({
  url: "ws://localhost:3000",
  WebSocket,
});
```

## License

MIT
