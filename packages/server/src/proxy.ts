/**
 * What we are willing to believe about where a request came from.
 *
 * The `X-Forwarded-*` family is written by whoever sits in front of us — and
 * on a direct deployment, that is the client. Node's own parser polices the
 * bare `Host` header; nothing polices these, and Fly does not strip inbound
 * copies of them. So they are read only under `TRUST_PROXY=1`, exactly as the
 * rate limiter reads `x-forwarded-for` (see `clientIp` in ws.ts), and even
 * then only if they look like a host and a scheme.
 *
 * The env is read per call rather than latched at import: it costs nothing,
 * and a module-level constant is a thing tests cannot turn on and off.
 */
export function trustsProxy(): boolean {
  return process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
}

/**
 * A character allowlist, not a pattern match, and that is the point: the
 * value ends up inside a quoted HTML attribute, so what matters is that
 * `"`, `<`, `>`, whitespace and control characters cannot appear — not that
 * the rest is a well-formed authority. Brackets and colons are in so an IPv6
 * literal (`[::1]:8787`) still works for somebody self-hosting on one.
 *
 * The length cap is the other half. Without it a header of eight thousand
 * characters is eight thousand characters reflected into every page.
 */
const HOST_SHAPE = /^[A-Za-z0-9.\-:[\]]{1,255}$/;

export function isSafeHost(host: string | undefined): host is string {
  return host !== undefined && HOST_SHAPE.test(host);
}

export function isSafeProto(proto: string | undefined): proto is string {
  return proto === 'http' || proto === 'https';
}
