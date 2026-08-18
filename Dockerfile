# Self-host sloppers in one container: server + built web app.
#   docker build -t sloppers .
#   docker run -p 8787:8787 -v sloppers-data:/data sloppers
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++ && corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @sloppers/server --prod deploy --legacy /srv/server
# Legacy deploy leaves workspace deps as symlinks into /repo, which the
# runtime stage doesn't have — materialize them as real directories.
RUN rm -rf /srv/server/node_modules/@sloppers/protocol && \
    mkdir -p /srv/server/node_modules/@sloppers/protocol && \
    cp -r /repo/packages/protocol/dist /repo/packages/protocol/package.json \
      /srv/server/node_modules/@sloppers/protocol/

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    WEB_DIST=/srv/web
COPY --from=build /srv/server /srv/server
COPY --from=build /repo/packages/web/dist /srv/web
WORKDIR /srv/server
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/main.js"]
