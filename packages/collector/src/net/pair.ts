import { type PairRedeemResponse, pairRedeemResponseSchema } from '@sloppers/protocol';

/**
 * Share targets come from the web app as `CODE@host[:port]`, one paste-able
 * token that encodes both the pairing code and where the office lives.
 * Plain hosts get https; localhost gets http so local dev just works. An
 * explicit scheme (`CODE@http://host`) always wins.
 */
export function parseShareTarget(arg: string): { code: string; httpUrl: string } {
  const at = arg.indexOf('@');
  if (at <= 0 || at === arg.length - 1) {
    throw new Error(`Expected a share code like ABC-123@office.example.com, got: ${arg}`);
  }
  const code = arg.slice(0, at);
  let host = arg.slice(at + 1).replace(/\/+$/, '');
  if (!/^[a-z]+:\/\//i.test(host)) {
    const bare = host.split(':')[0] ?? '';
    const isLocal = bare === 'localhost' || bare === '127.0.0.1' || bare === '[::1]';
    host = `${isLocal ? 'http' : 'https'}://${host}`;
  }
  return { code, httpUrl: host };
}

export function wsUrlFor(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}

export async function redeemPairingCode(
  httpUrl: string,
  code: string,
): Promise<PairRedeemResponse> {
  const res = await fetch(`${httpUrl}/api/pair/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode: code }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      res.status === 404 || res.status === 410
        ? 'That share code is invalid or expired — generate a fresh one from the office.'
        : `Pairing failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  return pairRedeemResponseSchema.parse(await res.json());
}
