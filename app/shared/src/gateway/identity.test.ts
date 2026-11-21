import { describe, expect, it } from 'vitest';
import { gatewayIdentity } from './identity';

const USER = '423456789012345678';
const encode = (value: unknown, encoding: BufferEncoding = 'base64url') =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString(encoding);

describe('gatewayIdentity', () => {
  it('reads the Discord id and name of the validated session claims', () => {
    const header = encode({ iss: 'signer@demo-pixelwar-test.iam.gserviceaccount.com', aud: 'demo-pixelwar-test',
      sub: USER, name: 'Synthetic user', iat: 1, exp: 2, auth_time: 1 });
    expect(gatewayIdentity(header)).toEqual({ uid: USER, name: 'Synthetic user' });
  });

  it('accepts standard base64 with padding as well as base64url', () => {
    const claims = { sub: USER, name: 'é?>' };
    expect(gatewayIdentity(encode(claims, 'base64'))).toEqual({ uid: USER, name: 'é?>' });
    expect(gatewayIdentity(encode(claims))).toEqual({ uid: USER, name: 'é?>' });
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['oversized', 'A'.repeat(8193)],
    ['not base64', 'not base64!'],
    ['not JSON', encode('not-json')],
    ['invalid UTF-8', Buffer.from([0x22, 0xff, 0x22]).toString('base64url')],
    ['a JSON array', encode([USER])],
    ['null', encode('null')],
    ['missing sub', encode({ name: 'Synthetic user' })],
    ['numeric sub', encode({ sub: 423456789012345678, name: 'Synthetic user' })],
    ['non snowflake sub', encode({ sub: '0123', name: 'Synthetic user' })],
    ['missing name', encode({ sub: USER })],
    ['empty name', encode({ sub: USER, name: '' })],
    ['too long name', encode({ sub: USER, name: 'n'.repeat(81) })],
  ])('refuses a header that is %s', (_case, header) => {
    expect(gatewayIdentity(header)).toBeUndefined();
  });
});
