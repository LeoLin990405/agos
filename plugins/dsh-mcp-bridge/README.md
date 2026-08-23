# DSH MCP bridge

`POST /mcp` exposes a stateless MCP 2025-03-26 Streamable HTTP endpoint. It is
intended only for clients on this machine. If a second machine must reach it,
publish it through an authenticated Tailscale reverse proxy; never expose the
DSH webServer directly to a LAN or the public Internet.

The plugin does not open a socket, change the host listen address, or add an
authentication layer. It only contributes `/mcp` to the existing loopback
`webServer` trust boundary. JSON and `text/event-stream` responses are both
supported. `agos_prompt` is the only tool that starts model work and consumes
model quota; the other four tools are read-only.
