import { describe, expect, it, vi } from 'vitest';
import { createOriginalResponseEditor, textResponse, UPLOAD_TIMEOUT_MS } from './original-response';

const created = 1_800_000_000_000;
const target = { application_id: '123456789012345678', interaction_token: 'synthetic-interaction-token', created_at: created };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('original response with an image (BOT-06)', () => {
  it('sends payload_json and files[0] as multipart, listing only the new attachment', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }));
    const edit = createOriginalResponseEditor({ fetch: fetch as unknown as typeof globalThis.fetch, now: () => created + 1000 });
    expect(await edit(target, textResponse('Zone peinte'), { filename: 'pixelwar.png', data: png })).toBe('updated');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/v10/webhooks/123456789012345678/synthetic-interaction-token/messages/@original');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toBeUndefined();
    const form = init.body as FormData;
    expect(JSON.parse(form.get('payload_json') as string)).toEqual({
      content: 'Zone peinte', allowed_mentions: { parse: [] }, embeds: [], components: [],
      attachments: [{ id: 0, filename: 'pixelwar.png' }],
    });
    const file = form.get('files[0]') as File;
    expect(file.name).toBe('pixelwar.png');
    expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);
  });

  it('keeps the JSON body for a text answer', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }));
    const edit = createOriginalResponseEditor({ fetch: fetch as unknown as typeof globalThis.fetch, now: () => created + 1000 });
    await edit(target, textResponse('La toile est vide.'));
    const init = (fetch.mock.calls[0] as [string, RequestInit])[1];
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).not.toHaveProperty('attachments');
  });

  it('gives an upload more time than a text edit, still bounded by the token lifetime', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }));
    const edit = createOriginalResponseEditor({ fetch: fetch as unknown as typeof globalThis.fetch, now: () => created + 1000 });
    await edit(target, textResponse('x'), { filename: 'pixelwar.png', data: png });
    expect(timeout).toHaveBeenLastCalledWith(UPLOAD_TIMEOUT_MS);
    const late = createOriginalResponseEditor({ fetch: fetch as unknown as typeof globalThis.fetch, now: () => created + 15 * 60_000 - 2000 });
    await late(target, textResponse('x'), { filename: 'pixelwar.png', data: png });
    expect(timeout).toHaveBeenLastCalledWith(2000);
    timeout.mockRestore();
  });

  it.each(['../token.png', 'image.gif', '', 'A.png'])('refuses the attachment name %j before any request', async (filename) => {
    const fetch = vi.fn();
    const edit = createOriginalResponseEditor({ fetch: fetch as unknown as typeof globalThis.fetch, now: () => created + 1000 });
    await expect(edit(target, textResponse('x'), { filename, data: png })).rejects.toThrow('Invalid attachment');
    expect(fetch).not.toHaveBeenCalled();
  });
});
