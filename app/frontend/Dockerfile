# syntax=docker/dockerfile:1
# Frontend image (ADR-0011). Build context: app/ (npm workspace and lockfile).
#   docker buildx build -f app/frontend/Dockerfile app
# Base images are pinned by digest (SEC-02); update tag and digest together.

FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
# Whole workspace (see Dockerfile.dockerignore): npm ci checks every workspace against
# the lockfile, then installs only the frontend dependencies.
COPY . .
RUN npm ci --workspace=@pixelwar/frontend --no-audit --no-fund \
 && npm run build --workspace=@pixelwar/frontend

FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03

# Only these variables are substituted in the template (nginx's own $uri etc. are kept).
ENV NGINX_ENVSUBST_FILTER="^(APP_ENV|GATEWAY_URL|REALTIME_URL|DISCORD_CLIENT_ID)$"

USER root
# The rendered template replaces the image's default server; conf.d stays writable by nginx.
RUN rm -f /etc/nginx/conf.d/default.conf && chown 101:0 /etc/nginx/conf.d && chmod 775 /etc/nginx/conf.d
USER 101

COPY --chown=101:0 frontend/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chown=101:0 --chmod=755 frontend/nginx/05-check-config.envsh /docker-entrypoint.d/05-check-config.envsh
COPY --from=build --chown=101:0 /app/frontend/dist /usr/share/nginx/html

EXPOSE 8080
