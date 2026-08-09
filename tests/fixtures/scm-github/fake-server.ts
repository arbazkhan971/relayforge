import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GithubTransport, GithubTransportRequest } from "../../../src/scm/github.js";

export type FakeGithubRequest = Readonly<{
  method: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Buffer;
}>;

export type FakeGithubReply = Readonly<{
  status?: number;
  headers?: Readonly<Record<string, string>>;
  json?: unknown;
  body?: string | Uint8Array;
  /** Keep the socket open until the client aborts. */
  hang?: boolean;
}>;

export type FakeGithubHandler = (request: FakeGithubRequest) => FakeGithubReply | Promise<FakeGithubReply>;

export type FakeGithubServer = Readonly<{
  origin: string;
  requests: FakeGithubRequest[];
  transport: GithubTransport;
  close(): Promise<void>;
}>;

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new Error("fake request body too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function headers(request: IncomingMessage): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [
    key,
    Array.isArray(value) ? value.join(",") : value
  ]));
}

function respond(response: ServerResponse, reply: FakeGithubReply): void {
  if (reply.hang) return;
  const value = reply.json === undefined
    ? reply.body === undefined ? Buffer.alloc(0) : Buffer.from(reply.body)
    : Buffer.from(JSON.stringify(reply.json), "utf8");
  response.writeHead(reply.status ?? 200, {
    ...(reply.json === undefined ? {} : { "content-type": "application/json" }),
    "content-length": String(value.byteLength),
    ...(reply.headers ?? {})
  });
  response.end(value);
}

export async function startFakeGithubServer(handler: FakeGithubHandler): Promise<FakeGithubServer> {
  const requests: FakeGithubRequest[] = [];
  const server = createServer(async (incoming, response) => {
    try {
      const request: FakeGithubRequest = {
        method: incoming.method ?? "GET",
        path: incoming.url ?? "/",
        headers: headers(incoming),
        body: await body(incoming)
      };
      requests.push(request);
      respond(response, await handler(request));
    } catch {
      respond(response, { status: 500, json: { message: "fake server failure" } });
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const transport: GithubTransport = async (request: GithubTransportRequest) => {
    const original = new URL(request.url);
    const target = new URL(`${original.pathname}${original.search}`, origin);
    return await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      redirect: request.redirect
    });
  };
  return {
    origin,
    requests,
    transport,
    close: async () => {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  };
}
