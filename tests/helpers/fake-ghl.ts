import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(__dirname, "..", "fixtures", "ghl");
export const fixture = <T = unknown>(name: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as T;

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

/**
 * A fetch() stand-in that serves recorded GHL fixtures. `data` can be edited
 * between runs to simulate changes in GHL.
 */
export function fakeGhl() {
  const data = {
    pipelines: fixture("pipelines"),
    messagesPage1: fixture("messages-page1"),
    messagesPage2: fixture("messages-page2"),
    contacts: fixture("contacts-search"),
    contactById: { ct3: fixture("contact-ct3") } as Record<string, unknown>,
    opportunities: fixture<{ opportunities: Record<string, unknown>[] }>("opportunities"),
  };
  const requests: RecordedRequest[] = [];

  const fetchImpl = async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const ok = (b: unknown) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { "x-ratelimit-remaining": "95", "x-ratelimit-daily-remaining": "199000" },
      });

    if (method !== "GET" && url.pathname !== "/contacts/search") {
      return new Response("write attempted", { status: 500 });
    }
    if (url.pathname === "/opportunities/pipelines") return ok(data.pipelines);
    if (url.pathname === "/conversations/messages/export") {
      return ok(url.searchParams.get("cursor") === "cursor-2" ? data.messagesPage2 : data.messagesPage1);
    }
    if (url.pathname === "/contacts/search") return ok(data.contacts);
    if (url.pathname.startsWith("/contacts/")) {
      const id = url.pathname.split("/")[2];
      const c = data.contactById[id];
      return c ? ok(c) : new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    }
    if (url.pathname === "/opportunities/search") return ok(data.opportunities);
    return new Response("unexpected path " + url.pathname, { status: 404 });
  };

  return { fetchImpl: fetchImpl as unknown as typeof fetch, data, requests };
}
