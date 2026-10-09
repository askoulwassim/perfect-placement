/*
 * Vault backup before `pp uninstall --purge`: a plain POSIX (ustar + pax) tar.gz written with node's
 * zlib, so it needs no `tar` binary and opens with any tar (`tar -xzf <file> -C <parent>`). The file
 * is created 0600 in a 0700 dir and read back (every entry counted) before anything is deleted.
 */
import { chmodSync, createReadStream, createWriteStream, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

const BLOCK = 512;

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

function header(name: string, o: { mode: number; size: number; mtime: number; type: '0' | '2' | '5' | 'x'; link?: string }): Buffer {
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 100, 'utf8');
  b.write(octal(o.mode & 0o7777, 8), 100, 'ascii');
  b.write(octal(0, 8), 108, 'ascii');
  b.write(octal(0, 8), 116, 'ascii');
  b.write(octal(o.size, 12), 124, 'ascii');
  b.write(octal(Math.floor(o.mtime), 12), 136, 'ascii');
  b.write('        ', 148, 'ascii');
  b.write(o.type, 156, 'ascii');
  if (o.link) b.write(o.link, 157, 100, 'utf8');
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return b;
}

const pad = (n: number) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);

/** A pax record `<len> key=value\n` (len counts itself). */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

const fits = (s: string) => Buffer.byteLength(s) < 100 && /^[\x20-\x7e]*$/.test(s);

function* entry(name: string, o: { mode: number; size: number; mtime: number; type: '0' | '2' | '5'; link?: string }): Generator<Buffer> {
  const pax = [!fits(name) ? paxRecord('path', name) : '', o.link && !fits(o.link) ? paxRecord('linkpath', o.link) : ''].join('');
  if (pax) {
    const data = Buffer.from(pax);
    yield header('PaxHeader', { mode: 0o644, size: data.length, mtime: o.mtime, type: 'x' });
    yield data;
    yield pad(data.length);
  }
  yield header(fits(name) ? name : name.slice(-99).replace(/^[^\x20-\x7e]+/, ''), {
    ...o,
    ...(o.link ? { link: fits(o.link) ? o.link : '' } : {}),
  });
}

export interface TarResult {
  /** Entries written (files, dirs, symlinks). */
  entries: number;
  files: number;
  bytes: number;
}

/**
 * tar.gz of `root` (entries named `<basename(root)>/...`) to `out` (created 0600, never overwritten).
 * `exclude(rel)` skips a path (and everything under it); rel uses `/`.
 */
export async function writeTarGz(root: string, out: string, exclude: (rel: string) => boolean = () => false): Promise<TarResult> {
  const top = basename(root);
  const res: TarResult = { entries: 0, files: 0, bytes: 0 };
  function* walk(abs: string, rel: string): Generator<Buffer> {
    const st = lstatSync(abs);
    const name = rel ? `${top}/${rel}` : top;
    const mtime = st.mtimeMs / 1000;
    if (st.isDirectory()) {
      res.entries++;
      yield* entry(`${name}/`, { mode: st.mode, size: 0, mtime, type: '5' });
      for (const f of readdirSync(abs).sort()) {
        const r = rel ? `${rel}/${f}` : f;
        if (!exclude(r)) yield* walk(join(abs, f), r);
      }
    } else if (st.isSymbolicLink()) {
      res.entries++;
      yield* entry(name, { mode: st.mode, size: 0, mtime, type: '2', link: readlinkSync(abs) });
    } else if (st.isFile()) {
      // Read whole: the size in the header must match the bytes that follow even if the file grows.
      const data = readFileSync(abs);
      res.entries++;
      res.files++;
      res.bytes += data.length;
      yield* entry(name, { mode: st.mode, size: data.length, mtime, type: '0' });
      yield data;
      yield pad(data.length);
    }
  }
  function* all(): Generator<Buffer> {
    yield* walk(root, '');
    yield Buffer.alloc(BLOCK * 2);
  }
  await pipeline(Readable.from(all()), createGzip(), createWriteStream(out, { flags: 'wx', mode: 0o600 }));
  chmodSync(out, 0o600);
  return res;
}

/** Entry names in a tar.gz (pax paths applied), streaming. Throws on a truncated or corrupt archive. */
export async function listTarGz(file: string): Promise<string[]> {
  const names: string[] = [];
  let buf = Buffer.alloc(0);
  let skip = 0;
  let paxPath: string | null = null;
  let collectPax: { left: number; chunks: Buffer[] } | null = null;
  let ended = false;
  const gunzip = createReadStream(file).pipe(createGunzip());
  for await (const chunk of gunzip as AsyncIterable<Buffer>) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (skip > 0) {
        const n = Math.min(skip, buf.length);
        if (collectPax && collectPax.left > 0) {
          const take = Math.min(collectPax.left, n);
          collectPax.chunks.push(buf.subarray(0, take));
          collectPax.left -= take;
        }
        buf = buf.subarray(n);
        skip -= n;
        if (skip > 0) break;
        if (collectPax) {
          const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(Buffer.concat(collectPax.chunks).toString('utf8'));
          paxPath = m ? (m[1] as string) : null;
          collectPax = null;
        }
      }
      if (ended || buf.length < BLOCK) break;
      const h = buf.subarray(0, BLOCK);
      buf = buf.subarray(BLOCK);
      if (h.every((x) => x === 0)) {
        ended = true;
        break;
      }
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
      if (sum !== Number.parseInt(h.subarray(148, 156).toString('ascii').replace(/\0.*$/s, '').trim(), 8))
        throw new Error('bad tar header checksum');
      const size = Number.parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
      const type = String.fromCharCode(h[156] as number);
      skip = size + ((BLOCK - (size % BLOCK)) % BLOCK);
      if (type === 'x') {
        collectPax = { left: size, chunks: [] };
        continue;
      }
      names.push(paxPath ?? h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, ''));
      paxPath = null;
    }
  }
  if (!ended || skip > 0) throw new Error('truncated tar archive');
  return names;
}

/** `~/perfect-placement-backups` (0700). */
export function ensureBackupDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
