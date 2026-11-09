# Always-on server image (Railway, Render, Fly.io): no upload size limit from the platform,
# background transcription jobs keep running, ffmpeg comes from the system packages.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# ffmpeg-static's install script downloads a binary we do not need: the system ffmpeg is used.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    APP_DATA_DIR=/data
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./
RUN mkdir -p /data
EXPOSE 3000
CMD ["sh", "-c", "npx next start -H 0.0.0.0 -p ${PORT:-3000}"]
