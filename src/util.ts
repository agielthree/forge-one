// Shared helpers: deterministic time, hashing, pkt-line framing, compression.
// No Date.now() anywhere in request paths: every timestamp the forge emits is a
// fixed constant, so two runs of the same trial produce byte-identical state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The competition opened 2026-11-14T06:30:00Z; every timestamp the forge emits. */
export const FROZEN_EPOCH = 1794613800;
export const FROZEN_ISO = '2026-11-14T06:30:00.000Z';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function b64urlDecode(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

/** One pkt-line frame around `payload` (payload already includes its trailing \n where wanted). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');
export const PKT_DELIM: Buffer = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktPacket {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Decode a pkt-line stream. Returns the packets and any trailing bytes that did
 * not form a complete packet (the packfile after a receive-pack command list).
 * A malformed length prefix is reported as `error` instead of throwing.
 */
export function decodePktLines(buf: Buffer): { packets: PktPacket[]; rest: Buffer; error?: string } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      return { packets, rest: buf.subarray(offset), error: `bad pkt-line length ${JSON.stringify(head)}` };
    }
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      // A flush ends the pkt-line stream: anything after it is payload
      // (the packfile after a receive-pack command list), not more framing.
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) {
      return { packets, rest: buf.subarray(offset), error: 'truncated pkt-line' };
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, rest: buf.subarray(offset) };
}

export function deflate(data: Buffer): Buffer {
  return deflateSync(data, { level: 1 });
}

export function inflate(data: Buffer): Buffer {
  return inflateSync(data);
}

/** Split `buf` into chunks of at most `size` bytes. */
export function chunkBuffer(buf: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < buf.length; offset += size) {
    out.push(buf.subarray(offset, Math.min(buf.length, offset + size)));
  }
  if (out.length === 0) out.push(Buffer.alloc(0));
  return out;
}
