# Custom-provider DNS pinning hardening plan

## Security invariant

For every `platform === 'custom'` request, the address used for the upstream TCP connection must be one of the addresses assessed for that request. Validation and connection must not independently resolve the hostname. Every DNS answer must be classified; reject the whole answer set if any answer is forbidden. Keep the original hostname for HTTP Host, TLS SNI, certificate validation, and URL authority. Never follow redirects.

## Transport policy

### 1. Direct Undici/fetch
- Resolve once per request with `dns.promises.lookup(host, { all: true, verbatim: true }`.
- Classify the complete answer set and reject forbidden addresses before opening a socket.
- Create a request-scoped Undici `Agent`/dispatcher whose connector lookup returns only the vetted address set; do not use global fetch's independent resolver.
- Preserve hostname for TLS SNI and certificate verification. Disable redirects.
- Do not cache the approved address across requests; destroy the request-scoped dispatcher after response-body consumption/cancellation. If lifecycle management cannot be guaranteed, use a bounded dispatcher lifecycle with explicit close handling.

### 2. HTTP/HTTPS forward proxy
- Local DNS pinning does not control the destination selected by a remote forward proxy.
- Do not send a custom-provider target hostname through a forward proxy unless the proxy protocol supports a verifiable pinned destination.
- Fail closed for this route initially with a clear error. A later implementation may connect to a vetted IP while preserving Host/SNI, but must prove CONNECT and TLS semantics for HTTP and HTTPS proxies with integration tests.

### 3. SOCKS
- Current SOCKS routing deliberately sends the hostname to the proxy for domain-based routing. That means the proxy resolves DNS and can select an unvetted IP.
- Do not send custom-provider hostnames through SOCKS until the proxy can be constrained to a vetted address without breaking routing policy. Fail closed with a clear error rather than claim local DNS validation protects the remote resolution.
- If a future pinned-IP SOCKS mode is implemented, explicitly test SOCKS5 IPv4/IPv6 destination encoding, TLS SNI, local/private endpoint compatibility, and domain-based proxy rules.

### 4. Fetch Relay
- The client validates the relay URL separately from the target URL, but cannot control DNS or egress from the relay server.
- Fail closed for custom-provider requests in relay mode until the relay contract accepts a vetted target IP and enforces it at its own socket boundary, or provides equivalent audited SSRF protection. Never treat a client-side check as relay-side protection.

## DNS rebinding regression matrix

Use an injected resolver and deterministic mocked transport; no live DNS/network in unit tests.

1. Public at validation, metadata/link-local/private on a second lookup: request uses exactly the first vetted address and performs no second lookup.
2. Mixed public + blocked answer set: reject the complete set.
3. Resolver throws, returns empty array, malformed address, or unsupported address class: reject.
4. IPv4 and IPv6 public answers: pinned lookup only returns approved addresses and preserves requested family semantics.
5. TLS: original hostname remains SNI and certificate hostname; HTTP Host remains the original authority.
6. Redirect to private/metadata address: redirect is manual and the request fails.
7. HTTP proxy, SOCKS, and relay modes: custom-provider request fails closed before any outbound request is dispatched.
8. Non-custom provider behavior and local Ollama/LM Studio behavior remain unchanged.
9. Abort/cancellation and streaming responses close the request-scoped dispatcher without truncating valid streams or leaking sockets.
10. Parallel requests to the same hostname with different resolver answers never share pinned addresses or dispatchers.

## Acceptance criteria

- Unit tests cover every transport and the rebinding sequence above.
- Integration tests verify the actual socket destination for direct HTTPS and verify that proxy/relay routes fail before sending credentials or provider payload.
- Server TypeScript build, focused URL-guard/proxy tests, full server tests, lint, and CI pass.
- PR description states residual limitations honestly; do not merge until acceptance criteria are met.
