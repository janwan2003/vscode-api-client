import type { RunRow, RunSummary } from '../core/exec.ts';

/** A run row plus where the request lives, for annotations and JUnit. */
export interface CliRow extends RunRow {
  /** Path relative to the working directory, '/'-separated. */
  file: string;
  /** 1-based line of the request line. */
  line: number;
  /** Response body (truncated) for failed requests in --verbose mode and JSON output. */
  responseBody?: string;
  /** For a server-sent events response: how many events arrived and how the stream ended. For a WebSocket, also how many of them were sent. */
  stream?: { events: number; end: string; sent?: number };
  /** `client.log` / `console.log` output of the request's scripts. */
  logs?: string[];
}

const xml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** JUnit XML: one <testsuite> per .http file, one <testcase> per request. Understood by GitHub, GitLab, Jenkins, Azure. */
export function junitReport(rows: CliRow[], s: RunSummary): string {
  const byFile = new Map<string, CliRow[]>();
  for (const r of rows) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<testsuites name="plainwire" tests="${s.total}" failures="${s.failed}" errors="${s.errors}" skipped="${s.skipped}" time="${(s.timeMs / 1000).toFixed(3)}">`];
  for (const [file, rs] of byFile) {
    const sum = (st: RunRow['state']) => rs.filter((r) => r.state === st).length;
    const time = rs.reduce((t, r) => t + (r.timeMs ?? 0), 0) / 1000;
    out.push(`  <testsuite name="${xml(file)}" tests="${rs.length}" failures="${sum('fail')}" errors="${sum('error')}" skipped="${sum('skipped')}" time="${time.toFixed(3)}">`);
    for (const r of rs) {
      const name = `${r.method} ${r.label}`;
      const open = `    <testcase name="${xml(name)}" classname="${xml(file)}" file="${xml(file)}" line="${r.line}" time="${((r.timeMs ?? 0) / 1000).toFixed(3)}"`;
      if (r.state === 'pass') out.push(`${open}/>`);
      else if (r.state === 'skipped') out.push(`${open}><skipped${r.error ? ` message="${xml(r.error)}"` : ''}/></testcase>`);
      else if (r.state === 'error') out.push(`${open}><error message="${xml(r.error ?? 'error')}">${xml(r.error ?? '')}</error></testcase>`);
      else {
        const msg = failureText(r);
        out.push(`${open}><failure message="${xml(msg.split('\n')[0])}">${xml(msg)}</failure></testcase>`);
      }
    }
    out.push('  </testsuite>');
  }
  out.push('</testsuites>', '');
  return out.join('\n');
}

/** Why a request failed, one line per failed check. */
export function failureText(r: CliRow): string {
  const failed = r.assertions.filter((a) => !a.passed);
  if (failed.length) return failed.map((a) => `${a.source}: ${a.message}`).join('\n');
  if (r.error) return r.error;
  return `HTTP ${r.status ?? '?'} (a request without # @assert lines passes on status < 400)`;
}

export function jsonReport(rows: CliRow[], s: RunSummary): string {
  return JSON.stringify({ tool: 'plainwire', summary: s, requests: rows }, null, 2) + '\n';
}

/** `::error file=..,line=..::message` lines that GitHub Actions shows on the PR diff. */
export function githubAnnotations(rows: CliRow[]): string[] {
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const prop = (s: string) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return rows
    .filter((r) => r.state === 'fail' || r.state === 'error')
    .map((r) => `::error file=${prop(r.file)},line=${r.line},title=${prop(`${r.method} ${r.label}`)}::${esc(failureText(r))}`);
}
