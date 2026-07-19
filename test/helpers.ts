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
