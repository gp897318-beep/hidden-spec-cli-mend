// mend: applies an AI-written edit to a tree of text files, in four formats:
// unified diff, SEARCH/REPLACE blocks, V4A patches and JSON edits.
// This file follows starter/SPEC.md (version 1). Node 22, standard library only;
// run as `node main.ts [options] [PATCH]`.
//
// How it is put together: patch text is split into lines (section 3); the format
// is detected or forced (section 4); one of the four readers below turns the
// patch into a list of edits (sections 6 to 9); the edits run in order against
// an in-memory tree (section 10) and only then is anything written, so a failed
// edit leaves no trace. Line matching is the three-tier search of section 5,
// shared by the three line-based formats. The trial hand-over at the bottom is
// the kit's and is left alone.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Exit 2 with exactly one line: usage, no-patch, format or parse. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** Section 3: a patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Byte order of paths (UTF-8), as section 2 wants the output sorted. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Section 3: a file as its lines, its own line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const lf = text.indexOf('\n');
  const br: '\n' | '\r\n' = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  const pieces = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) pieces.pop();
  return { lines: pieces, br, finalBreak };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBreak ? s.br : '');
}

/** Section 5: one line read at a tier: 0 as it is, 1 without trailing spaces/tabs, 2 without leading or trailing. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Section 5: every 0-based position where O occurs in lines at a tier; occurrences may overlap. */
function occurrences(O: string[], lines: string[], tier: number): number[] {
  const at: number[] = [];
  if (O.length === 0 || O.length > lines.length) return at;
  const want = O.map((l) => normLine(l, tier));
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) at.push(i);
  }
  return at;
}

/** Section 5: the first tier (0, then 1, then 2; only 0 when strict) where O occurs, with all its positions. */
function findTier(O: string[], lines: string[], strict: boolean): { positions: number[]; tier: number } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrences(O, lines, t);
    if (pos.length > 0) return { positions: pos, tier: t };
  }
  return null;
}

/** Sections 5 and 8: like findTier, but only occurrences at or after `from` (the V4A cursor). */
function findTierFrom(O: string[], lines: string[], from: number, strict: boolean): { positions: number[]; tier: number } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrences(O, lines, t).filter((p) => p >= from);
    if (pos.length > 0) return { positions: pos, tier: t };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/**
 * Section 5: replace the k matched lines at pos with N. A context line (ctx[i]
 * is its index in O) is written as the file's own matched line, never the
 * patch's. At tier 2 every other line of N is re-indented from P (the leading
 * spaces and tabs of O's first line) to F (those of the file's first matched
 * line): a line that is not empty, not only whitespace, and starts with P has
 * that P replaced by F; any other line is written as it is. At tiers 0 and 1
 * the lines of N are written as they are.
 */
function applyReplace(lines: string[], pos: number, O: string[], N: string[], tier: number, ctx: (number | null)[]): string[] {
  const f = leadingWs(lines[pos]!);
  const p = leadingWs(O[0]!);
  const made: string[] = [];
  for (let i = 0; i < N.length; i++) {
    const c = ctx[i];
    if (c !== null && c !== undefined) {
      made.push(lines[pos + c]!);
      continue;
    }
    let s = N[i]!;
    if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
    made.push(s);
  }
  return [...lines.slice(0, pos), ...made, ...lines.slice(pos + O.length)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit: apply it to the tree (throwing Fail when it cannot), and the moves it made, if any. */
interface Edit {
  apply(tree: Tree): void;
  moves: Array<[string, string]>;
}

/** One line of a hunk or chunk body: its kind, its text after the first character, and whether the patch line was empty. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  blank: boolean;
}

/** Split a hunk or chunk body into old lines O, new lines N, and for each line of N the index of its context line in O (or null). */
function splitBody(body: BodyLine[]): { O: string[]; N: string[]; ctx: (number | null)[] } {
  const O: string[] = [];
  const N: string[] = [];
  const ctx: (number | null)[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      ctx.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      ctx.push(null);
      N.push(b.text);
    }
  }
  return { O, N, ctx };
}

/** Whether a `\` line follows the body's last context or `+` line (section 6: it takes the final break away). */
function bodyNoEol(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const b = body[i]!;
    if (b.kind === ' ' || b.kind === '+') return body[i + 1]?.kind === '\\';
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface DiffHunk {
  a: number;
  body: BodyLine[];
}

interface DiffSection {
  dashOld?: string | null;
  dashNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  gitOld?: string;
  gitNew?: string;
  creation: boolean;
  deletion: boolean;
  hunks: DiffHunk[];
}

/** Apply one hunk to a file state. d is the sum over this section's earlier hunks of (N length minus O length). */
function applyHunk(fs: FileState, h: DiffHunk, d: number, strict: boolean, path: string): { fs: FileState; delta: number } {
  const { O, N, ctx } = splitBody(h.body);
  const noEol = bodyNoEol(h.body);
  if (O.length > 0) {
    const found = findTier(O, fs.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const out = applyReplace(fs.lines, best, O, N, found.tier, ctx);
    const finalBreak = best + O.length === fs.lines.length ? !noEol : fs.finalBreak;
    return { fs: { lines: out, br: fs.br, finalBreak }, delta: N.length - O.length };
  }
  const at = Math.min(h.a + d, fs.lines.length);
  const out = [...fs.lines.slice(0, at), ...N, ...fs.lines.slice(at)];
  const finalBreak = at === fs.lines.length ? !noEol : fs.finalBreak;
  return { fs: { lines: out, br: fs.br, finalBreak }, delta: N.length };
}

function applyHunks(fs: FileState, hunks: DiffHunk[], strict: boolean, path: string): FileState {
  let cur = fs;
  let d = 0;
  for (const h of hunks) {
    const res = applyHunk(cur, h, d, strict, path);
    d += res.delta;
    cur = res.fs;
  }
  return cur;
}

/** Whether a `\` line follows the section's last `+` line (a created file then ends without a break). */
function lastPlusNoEol(hunks: DiffHunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const body = hunks[hi]!.body;
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i]!.kind === '+') return body[i + 1]?.kind === '\\';
    }
  }
  return false;
}

function makeUnifiedEdit(sec: DiffSection, strict: boolean): Edit {
  const edit: Edit = {
    moves: [],
    apply(tree: Tree): void {
      const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renameFrom !== undefined ? sec.renameFrom : (sec.gitOld ?? null);
      const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renameTo !== undefined ? sec.renameTo : (sec.gitNew ?? null);
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      const creation = sec.creation || oldP === null;
      const deletion = !creation && (sec.deletion || newP === null);
      if (creation) {
        if (newP === null) return;
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
        tree.now.set(newP, joinFile({ lines: plus, br: '\n', finalBreak: plus.length > 0 && !lastPlusNoEol(sec.hunks) }));
        return;
      }
      if (deletion) {
        if (oldP === null) return;
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      if (oldP !== newP) {
        if (oldP === null || newP === null) return;
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const done = applyHunks(splitFile(tree.get(oldP)!), sec.hunks, strict, oldP);
        tree.now.set(newP, joinFile(done));
        tree.now.set(oldP, null);
        edit.moves.push([oldP, newP]);
        return;
      }
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      const done = applyHunks(splitFile(tree.get(p)!), sec.hunks, strict, p);
      tree.now.set(p, joinFile(done));
    },
  };
  return edit;
}

/**
 * Read a unified diff into one edit per section. A section starts at a
 * `diff --git a/<X> b/<Y>` line or at a `--- ` line followed by a `+++ ` line;
 * hunks start at `@@ -A[,B] +C[,D] @@` lines. Lines outside bodies that are not
 * part of a section header are ignored.
 */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: DiffSection[] = [];
  let cur: DiffSection | null = null;
  let state: 'none' | 'head' | 'body' | 'after' = 'none';
  let hunk: DiffHunk | null = null;

  const parseGit = (line: string, num: number): [string, string] => {
    const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line.trimEnd());
    if (m === null) throw new Exit2(`error: parse ${num}`);
    return [m[1]!, m[2]!];
  };
  const parseHunkHead = (line: string, num: number): number => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${num}`);
    return Number(m[1]);
  };
  const stripPath = (line: string): string | null => {
    let p = line.slice(4);
    const tab = p.indexOf('\t');
    if (tab >= 0) p = p.slice(0, tab);
    p = p.trim();
    if (p === '/dev/null') return null;
    if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
    return p;
  };
  const openSection = (git: [string, string] | null, dash: [string | null, string | null] | null): void => {
    cur = { creation: false, deletion: false, hunks: [] };
    if (git !== null) {
      cur.gitOld = git[0];
      cur.gitNew = git[1];
    }
    if (dash !== null) {
      cur.dashOld = dash[0];
      cur.dashNew = dash[1];
    }
    sections.push(cur);
    state = 'head';
    hunk = null;
  };
  const openHunk = (line: string, num: number): void => {
    const a = parseHunkHead(line, num);
    hunk = { a, body: [] };
    cur!.hunks.push(hunk);
    state = 'body';
  };
  const closeBody = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.blank) hunk.body.pop();
      hunk = null;
    }
    state = 'after';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const num = i + 1;
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        closeBody();
        openSection(parseGit(line, num), null);
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeBody();
        openSection(null, [stripPath(line), stripPath(lines[i + 1]!)]);
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        closeBody();
        openHunk(line, num);
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk!.body.push({
          kind: line === '' ? ' ' : (line[0] as ' ' | '-' | '+' | '\\'),
          text: line === '' ? '' : line.slice(1),
          blank: line === '',
        });
        continue;
      }
      closeBody();
    }
    if (state === 'head') {
      if (line.startsWith('diff --git ')) {
        openSection(parseGit(line, num), null);
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur!.dashOld = stripPath(line);
          cur!.dashNew = stripPath(lines[i + 1]!);
          i += 1;
        } else {
          throw new Exit2(`error: parse ${num + 1}`);
        }
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur!.dashNew = stripPath(line);
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur!.renameFrom = line.slice(12).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur!.renameTo = line.slice(10).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur!.creation = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur!.deletion = true;
        continue;
      }
      if (line.startsWith('@@')) {
        openHunk(line, num);
        continue;
      }
      continue;
    }
    if (state === 'after') {
      if (line.startsWith('diff --git ')) {
        openSection(parseGit(line, num), null);
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        openSection(null, [stripPath(line), stripPath(lines[i + 1]!)]);
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        openHunk(line, num);
        continue;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      openSection(parseGit(line, num), null);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      openSection(null, [stripPath(line), stripPath(lines[i + 1]!)]);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${num}`);
  }
  if (state === 'body') closeBody();
  // A section that changes nothing is no edit at all: a change of one path
  // with no hunks describes no change, so the reader finds no edit in it.
  // A creation, deletion or move with no hunks still changes the tree.
  const hasEffect = (sec: DiffSection): boolean => {
    const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renameFrom !== undefined ? sec.renameFrom : (sec.gitOld ?? null);
    const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renameTo !== undefined ? sec.renameTo : (sec.gitNew ?? null);
    const creation = sec.creation || oldP === null;
    const deletion = !creation && (sec.deletion || newP === null);
    if (creation || deletion) return true;
    if (oldP !== newP) return true;
    return sec.hunks.length > 0;
  };
  return sections.filter(hasEffect).map((sec) => makeUnifiedEdit(sec, strict));
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function makeSrEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return {
    moves: [],
    apply(tree: Tree): void {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile({ lines: newLines, br: '\n', finalBreak: newLines.length > 0 }));
        return;
      }
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      const fs = splitFile(cur);
      const found = findTier(oldLines, fs.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const out = applyReplace(fs.lines, found.positions[0]!, oldLines, newLines, found.tier, newLines.map(() => null));
      tree.now.set(path, joinFile({ lines: out, br: fs.br, finalBreak: fs.finalBreak }));
    },
  };
}

/**
 * Read SEARCH/REPLACE blocks. The path is the nearest non-blank, non-fence
 * line before the SEARCH line and after the previous block's REPLACE line;
 * a block with no such line takes the previous block's path, and the first
 * block with none is a parse error at its SEARCH line.
 */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    prevPath = path;
    prevEnd = rep;
    edits.push(makeSrEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    i = rep;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

/** Apply one V4A chunk. `cursor` is where the search starts; it ends just after the lines written. */
function applyV4aChunk(fs: FileState, ch: V4aChunk, cursor: number, strict: boolean, path: string): { fs: FileState; cursor: number } {
  const { O, N, ctx } = splitBody(ch.body);
  let at = cursor;
  if (ch.anchor !== null) {
    const found = findTierFrom([ch.anchor], fs.lines, cursor, strict);
    if (found === null) throw new Fail('no-match', path);
    at = found.positions[0]! + 1;
  }
  if (O.length > 0) {
    const found = findTierFrom(O, fs.lines, at, strict);
    if (found === null) throw new Fail('no-match', path);
    let pos = found.positions[0]!;
    if (ch.eof) {
      const ok = found.positions.filter((p) => p + O.length === fs.lines.length);
      if (ok.length === 0) throw new Fail('no-match', path);
      pos = ok[0]!;
    }
    const out = applyReplace(fs.lines, pos, O, N, found.tier, ctx);
    return { fs: { lines: out, br: fs.br, finalBreak: fs.finalBreak }, cursor: pos + N.length };
  }
  const ins = ch.eof ? fs.lines.length : at;
  const out = [...fs.lines.slice(0, ins), ...N, ...fs.lines.slice(ins)];
  return { fs: { lines: out, br: fs.br, finalBreak: fs.finalBreak }, cursor: ins + N.length };
}

function makeV4aAdd(path: string, made: string[]): Edit {
  return {
    moves: [],
    apply(tree: Tree): void {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ lines: made, br: '\n', finalBreak: made.length > 0 }));
    },
  };
}

function makeV4aDelete(path: string): Edit {
  return {
    moves: [],
    apply(tree: Tree): void {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    },
  };
}

function makeV4aUpdate(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  const edit: Edit = {
    moves: [],
    apply(tree: Tree): void {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      let fs = splitFile(cur);
      let cursor = 0;
      for (const ch of chunks) {
        const res = applyV4aChunk(fs, ch, cursor, strict, path);
        fs = res.fs;
        cursor = res.cursor;
      }
      const out = joinFile(fs);
      if (moveTo !== null) {
        tree.now.set(moveTo, out);
        tree.now.set(path, null);
        edit.moves.push([path, moveTo]);
      } else {
        tree.now.set(path, out);
      }
    },
  };
  return edit;
}

/**
 * Read a V4A patch: `*** Begin Patch` first, `*** End Patch` last, then one
 * edit per `*** Add/Delete/Update File:` section. Blank lines at the end of a
 * section are not part of it; blank lines between sections are ignored.
 */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    const headNo = i + 1;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${headNo}`);
    }
    i++;
    const raw: { text: string; no: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const made: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) made.push(r.text.slice(1));
        else if (r.text === '') made.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(makeV4aAdd(path, made));
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      edits.push(makeV4aDelete(path));
    } else {
      let moveTo: string | null = null;
      let at = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice(13).trim();
        at = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (; at < raw.length; at++) {
        const r = raw[at]!;
        const l = r.text;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.no}`);
          cur.eof = true;
          cur = null;
        } else if (l.startsWith('*** Move to: ')) {
          throw new Exit2(`error: parse ${r.no}`);
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({
            kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+' | '\\'),
            text: l === '' ? '' : l.slice(1),
            blank: l === '',
          });
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNo}`);
      edits.push(makeV4aUpdate(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 4: detecting the format                                     */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first]!.trimStart();
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  for (const l of lines) if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('diff --git ')) return 'unified';
    if (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits                                               */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return {
      moves: [],
      apply(tree: Tree): void {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      },
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      moves: [],
      apply(tree: Tree): void {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const nl = before.indexOf('\n');
        const crlf = nl > 0 && before[nl - 1] === '\r';
        const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const t = toLf(before);
        const old = toLf(oldStr);
        let count = 0;
        for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
        if (count === 0) throw new Fail('no-match', p);
        if (count > 1) throw new Fail('ambiguous', p);
        const at = t.indexOf(old);
        const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
        tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const at = o.insert_line;
    const add = patchLines(o.new_str);
    return {
      moves: [],
      apply(tree: Tree): void {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const fs = splitFile(before);
        if (at < 0 || at > fs.lines.length) throw new Fail('no-match', p);
        const lines = [...fs.lines];
        lines.splice(at, 0, ...add);
        tree.now.set(p, joinFile({ lines, br: fs.br, finalBreak: fs.finalBreak }));
      },
    };
  }
  return null;
}

/** Read a JSON patch: one array of edit objects, or one edit object per line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Sections 1, 2 and 10: invocation, output, order and atomicity       */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit.apply(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const byPath = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    byPath.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const extra: { key: string; line: string }[] = [];
  for (const edit of edits) {
    for (const [oldP, newP] of edit.moves) {
      if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
        const d = byPath.get(oldP);
        const a = byPath.get(newP);
        if (d !== undefined && d.startsWith('D ') && a !== undefined && a.startsWith('A ')) {
          byPath.delete(oldP);
          byPath.delete(newP);
          extra.push({ key: newP, line: `R ${oldP} -> ${newP}` });
        }
      }
    }
  }
  const rows = [...[...byPath.entries()].map(([p, line]) => ({ key: p, line })), ...extra]
    .sort((x, y) => byteOrder(x.key, y.key))
    .map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
