# Prism's phone relay

Lets a phone reach a Prism that has no address of its own — behind a router, on mobile data, anywhere.

Prism keeps one connection open to the relay, and every phone's traffic travels down it, each frame tagged with
the phone it belongs to. A phone connects exactly as it would to Prism directly, so it needs no idea the relay
is there.

**The relay cannot read any of it.** Everything after the first message is sealed between the phone and the
computer with keys neither of them ever sends here. It forwards bytes: it keeps no messages, writes no files
and logs no payloads — only that a computer arrived or left.

## Running it

```
npm install
PORT=8794 RELAY_SECRET=something-long node server.js
```

It listens on 127.0.0.1 only, for a web server in front of it to add TLS. On a server where you cannot change the web server, `HOST=0.0.0.0` makes it listen for everyone on its own port, and the phone uses `ws://the.server:8794/<the secret>`: still sealed end to end, since the relay never holds the keys, but the opening greeting is not hidden from someone watching the network.

Otherwise put it behind TLS. With Apache:

```
ProxyPass        /relay/ http://127.0.0.1:8794/ upgrade=websocket timeout=1200
ProxyPassReverse /relay/ http://127.0.0.1:8794/
```

In Prism: **Settings → Helpers & extras → Prism phone app → Relay**, set to
`wss://your.host/relay/<the secret>`.

`RELAY_SECRET` becomes a segment of the address. Without the right one every request is a plain 404, so only
someone who knows it can use the relay at all. Leave it empty and anyone who finds the address can.

## What it limits

50 computers, 20 phones per computer, 48 MB a message (a little over Prism's own cap, so file previews fit).
A computer's address is held for five minutes after it drops so a reconnect keeps it, and an address belongs to
whoever claimed it first — a different key asking for the same one gets a 409, which Prism shows as
"another Prism already uses this address there".
