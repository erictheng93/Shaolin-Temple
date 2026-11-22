# 前端靜態檔映像。建置情境是專案根目錄（docker build -t temple-web -f web/Dockerfile .）。
# VITE_WS_URL 會被編進 JS，只能在建置時決定：變更網址要重新建置映像。
FROM node:22.23-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
WORKDIR /app/web
RUN npm ci
WORKDIR /app
COPY shared ./shared
COPY web ./web
WORKDIR /app/web
ARG VITE_WS_URL=
ENV VITE_WS_URL=$VITE_WS_URL
# 型別檢查（vue-tsc）由 CI 負責：測試檔會引用 web/ 以外的 server/tests，不在這個建置情境內。
RUN npx vite build

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY web/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
