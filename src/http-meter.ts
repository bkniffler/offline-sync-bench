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

      let response: Response;
      const suppliedBody = init?.body;
      if (options.fixedLengthRequests &&
          (suppliedBody instanceof ArrayBuffer || ArrayBuffer.isView(suppliedBody))) {
        // The product already supplies a finite binary body. Preserve it and let
        // fetch derive Content-Length; counting must not buffer/copy it again.
        requestBytes += suppliedBody.byteLength;
        response = await baseFetch(input, init);
      } else {
        const request = new Request(input, init);
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
