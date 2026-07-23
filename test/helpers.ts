export function jsonFetch(body: unknown, init?: { status?: number }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

export function rejectingFetch(error: Error): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

/** For adapters (e.g. highway.ts) whose upstream returns raw text (XML) rather than JSON. */
export function textFetch(body: string, init?: { status?: number }): typeof fetch {
  return (async () =>
    new Response(body, {
      status: init?.status ?? 200,
      headers: { "content-type": "application/xml" }
    })) as unknown as typeof fetch;
}
