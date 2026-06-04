# pi2pi — Peer-to-peer messaging between pi instances

A proof-of-concept that lets two (or more) pi instances exchange messages via a shared broker.

## Architecture

```
┌──────────────────────┐         ┌──────────────┐         ┌──────────────────────┐
│  pi --name Alice      │◄───────►│   broker.ts  │◄───────►│  pi --name Bob       │
│  (pi2pi.ts extension) │  WS     │  (Bun HTTP)  │  WS     │  (pi2pi.ts extension)│
└──────────────────────┘         └──────────────┘         └──────────────────────┘
```

- **`broker.ts`** — A tiny Bun WebSocket server. It keeps a registry of named agents and routes messages between them.
- **`pi2pi.ts`** — A pi extension that registers `--name` / `--broker` flags, intercepts `@name message` input, and exchanges messages via the broker.

## Prerequisites

- [Bun](https://bun.sh) runtime for the broker: `curl -fsSL https://bun.sh/install | bash`
- [pi](https://github.com/badlogic/pi-mono) coding agent

## Quick start

### 1. Start the broker

```bash
bun broker.ts
# or on a custom port:
bun broker.ts --port 8080
```

### 2. Launch two pi instances (separate terminals)

```bash
# Terminal 1
pi -e ./pi2pi.ts --agent-name Alice --room engineering

# Terminal 2
pi -e ./pi2pi.ts --agent-name Bob --room engineering
```

Each instance shows a status indicator in the footer (e.g. `● Alice [Bob]`).

### 3. Use the commands

| Command | Description |
|---------|-------------|
| `/tell Bob what is the capital of France?` | Send a message to Bob's LLM and receive his reply |
| `/tell everyone introduce yourself briefly` | Broadcast to all connected agents; each replies individually |
| `/who` | Show who is currently connected |

Tab-completion works on the first argument of `/tell` — it offers `everyone` plus the names of online agents.

In Alice's session:
```
/tell Bob what is 2 + 2?
```
- Alice's conversation shows `📤 Bob: what is 2 + 2?`
- Bob's LLM receives the message and answers it
- Alice's conversation shows `💬 @Bob: 4` once the reply arrives

Bob's session shows the message as a user turn so he can see what was asked.

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--agent-name <name>` | **Required**. Name for this pi instance. | — |
| `--room <room>` | **Required**. Room to join — only agents in the same room can see and message each other. | — |
| `--broker <url>` | WebSocket URL of the broker. | `ws://localhost:7331` |

## Broker HTTP endpoint

`GET http://localhost:7331/agents` returns the list of currently connected agents:

```json
{ "rooms": { "engineering": ["Alice", "Bob"] } }
```

## Message flow

```
Alice types:  /tell Bob tell me a joke
     │
     ▼
/tell command handler
     │  sends  { type:"message", id:"uuid", to:"Bob", content:"tell me a joke" }
     ▼
broker.ts forwards  { type:"incoming", id:"uuid", from:"Alice", content:"tell me a joke" }
     │
     ▼
Bob's pi2pi.ts calls pi.sendUserMessage("[Message from @Alice]: tell me a joke")
     │
     ▼
Bob's LLM turns respond → agent_end fires
     │  sends  { type:"reply", id:"uuid", content:"<joke>" }
     ▼
broker.ts routes  { type:"reply_result", id:"uuid", from:"Bob", content:"<joke>" }
     │
     ▼
Alice's pi2pi.ts calls pi.sendMessage({ customType:"pi2pi-reply", ... })
Alice sees: 💬 @Bob: <joke>
```

For `/tell everyone`, the extension fans out one individual message per online agent.

## Notes

- The broker evicts old connections if the same name reconnects (e.g. after a reload).
- The extension auto-reconnects with exponential back-off if the broker drops.
- Replies are correlated with the original message by UUID so multiple in-flight messages work correctly.
- If the target agent isn't connected, the broker returns an error that is shown as a notification.
