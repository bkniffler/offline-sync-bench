export interface HttpMeterSnapshot {
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
}

export function createHttpMeter(
  baseFetch: typeof fetch = fetch,
  options: { streamResponses?: boolean; fixedLengthRequests?: boolean } = {}
): {
  fetch: typeof fetch;
  snapshot: () => HttpMeterSnapshot;
} {
  let requestCount = 0;
  let requestBytes = 0;
  let responseBytes = 0;

  const meteredFetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1;

      const request = new Request(input, init);
      let response: Response;
      if (request.body && options.fixedLengthRequests) {
        // Explicit compatibility path for transports requiring Content-Length.
        const bytes = await request.arrayBuffer();
        requestBytes += bytes.byteLength;
        response = await baseFetch(new Request(request, { body: bytes }));
      } else if (request.body) {
        const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { requestBytes += chunk.byteLength; controller.enqueue(chunk); },
        }));
        response = await baseFetch(new Request(request, { body, duplex: 'half' } as RequestInit));
      } else {
        response = await baseFetch(request);
      }
      if (options.streamResponses !== false && response.body) {
        // Long-lived sync responses must reach the client before EOF. Count
        // consumed chunks while preserving backpressure and cancellation.
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            responseBytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }));
        const meteredResponse = new Response(body, response);
        for (const key of ['url', 'redirected', 'type'] as const) {
          Object.defineProperty(meteredResponse, key, { value: response[key] });
        }
        return meteredResponse;
      }
      responseBytes += (await response.clone().arrayBuffer()).byteLength;
      return response;
    };

  const meteredFetch = Object.assign(
    meteredFetchImpl,
    typeof baseFetch.preconnect === 'function'
      ? {
          preconnect: baseFetch.preconnect.bind(baseFetch),
        }
      : {}
  ) as typeof fetch;

  return {
    fetch: meteredFetch,
    snapshot: () => ({
      requestCount,
      requestBytes,
      responseBytes,
    }),
  };
}
