# The web front end: built to static files and served by nginx. Nothing here
# talks to the database; the API base is baked in at build time.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE=/api-proxy
ARG VITE_PRINT_BRIDGE_URL=
ARG VITE_SCALE_BRIDGE_URL=
ARG VITE_SCALE_BAUD_RATE=9600
ARG VITE_HARDWARE_BRIDGE_TOKEN=
ENV VITE_API_BASE=$VITE_API_BASE
ENV VITE_PRINT_BRIDGE_URL=$VITE_PRINT_BRIDGE_URL
ENV VITE_SCALE_BRIDGE_URL=$VITE_SCALE_BRIDGE_URL
ENV VITE_SCALE_BAUD_RATE=$VITE_SCALE_BAUD_RATE
ENV VITE_HARDWARE_BRIDGE_TOKEN=$VITE_HARDWARE_BRIDGE_TOKEN
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
