interface BodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpMeterSnapshot {
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
}

function hasArrayBuffer(value: object): value is BodyLike {
  return 'arrayBuffer' in value && typeof value.arrayBuffer === 'function';
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

      const request =
        input instanceof Request ? input : new Request(input, init);
      let requestBody: ArrayBuffer | undefined;

      if (request.body) {
        const requestClone = request.clone();
        requestBody = await requestClone.arrayBuffer();
        requestBytes += requestBody.byteLength;
      } else if (typeof init?.body === 'string') {
        requestBytes += new TextEncoder().encode(init.body).byteLength;
      } else if (
        init?.body &&
        typeof init.body === 'object' &&
        hasArrayBuffer(init.body)
      ) {
        requestBytes += (await init.body.arrayBuffer()).byteLength;
      }

      // Cloning tees a Bun Request body into a stream, which fetch sends
      // chunked. Some native sync servers require Content-Length framing.
      const response = options.fixedLengthRequests && requestBody
        ? await baseFetch(input, { ...init, headers: request.headers, body: requestBody })
        : await baseFetch(request);
      if (options.streamResponses && response.body) {
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
