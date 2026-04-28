ARG DENO_VERSION=2.7.12

FROM denoland/deno:${DENO_VERSION} AS build

WORKDIR /app

COPY deno.json deno.lock ./
RUN deno install --frozen

COPY . .
RUN deno task build

FROM denoland/deno:${DENO_VERSION}

WORKDIR /app

ENV PORT=8000

COPY --from=build /app/deno.json /app/deno.lock ./
COPY --from=build /app/_fresh ./_fresh
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/static ./static

USER deno

EXPOSE 8000

CMD ["deno", "serve", "-A", "--host", "0.0.0.0", "--port", "8000", "_fresh/server.js"]
