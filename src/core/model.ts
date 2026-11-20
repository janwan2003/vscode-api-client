/** One HTTP header line. `disabled` headers are kept in the GUI but written as comments. */
export interface Header {
  name: string;
  value: string;
  disabled?: boolean;
}

/** A single request, independent of where it is stored. All strings are raw: `{{vars}}` are not resolved. */
export interface HttpRequest {
  /** From `# @name foo`. Used for request chaining (`{{foo.response.body.$.id}}`). */
  name?: string;
  /** Free text after the `###` separator, shown as the request title in the tree. */
  title?: string;
  method: string;
  /** Full URL including the query string. */
  url: string;
  /** e.g. `HTTP/1.1` when present on the request line. */
  httpVersion?: string;
  headers: Header[];
  /** Raw body text. A body starting with `< ` refers to a file. Undefined = no body. */
  body?: string;
  /** Other `# @key value` metadata lines (e.g. `@no-redirect`, `@note`). Value is '' for flags. */
  meta?: Record<string, string>;
  /**
   * Checks, in file order: `# @assert status == 200` lines without the `# @assert` prefix, and httpYac
   * `?? status == 200` lines verbatim (`??` included; written back after the headers/body). See core/assert.ts.
   */
  asserts?: string[];
  /** Plain comment lines above the request line, without the comment marker. */
  comments?: string[];
  /**
   * Lines kept verbatim but never run, above the request line: httpYac `{{ ... }}` scripts, JetBrains
   * `< {% ... %}` pre-request scripts and `/* ... *\/` block comments. Written back before the request line.
   */
  rawBefore?: string[];
  /**
   * Lines kept verbatim but never run, after the request: httpYac `{{ ... }}` scripts, JetBrains
   * `> {% ... %}` / `> handler.js` response handlers, httpYac `>> file` output redirects and `/*` ... `*\/`
   * comments. Written back last.
   */
  rawAfter?: string[];
}

/** `@name = value` file-level variable. */
export interface FileVariable {
  name: string;
  value: string;
}

/** A request plus its position in the source file (0-based, end exclusive). */
export interface ParsedRequest extends HttpRequest {
  startLine: number;
  endLine: number;
  /** Line of the request line (`GET https://...`), used for CodeLens placement. */
  requestLine: number;
}

export interface HttpFile {
  variables: FileVariable[];
  requests: ParsedRequest[];
  /**
   * Paths from `# @import ./other.http` (httpYac) and `import ./other.http` (JetBrains) lines, in file
   * order, as written (relative to this file). Their variables and named requests are available here.
   */
  imports?: string[];
}

/** Result of importing a foreign collection (Thunder Client, Postman, cURL). */
export interface ImportedCollection {
  name: string;
  /** Each folder becomes its own .http file; requests without a folder use folder ''. */
  folders: { name: string; requests: HttpRequest[] }[];
  /** Collection-level variables, written as `@name = value` at the top of each file. */
  variables: FileVariable[];
  /** Environments, written to `http-client.env.json` format: { envName: { var: value } }. */
  environments: Record<string, Record<string, string>>;
  /** Things that could not be converted (scripts, tests, unsupported auth...), shown to the user. */
  warnings: string[];
}

/** The response as shown in the GUI and stored in history. */
export interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  /** Text body (decoded as UTF-8), or base64 when `bodyEncoding` is 'base64'. */
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  /** Bytes received. */
  size: number;
  /** Milliseconds from start to full body. */
  timeMs: number;
  /** The URL after redirects. */
  url: string;
}
