# Multi-stage production build for React Vite frontend
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

# Lightweight Nginx runner
FROM nginx:alpine AS runner

COPY --from=builder /usr/src/app/dist /usr/share/nginx/html
EXPOSE 3000

# Custom Nginx config to serve SPA on port 3000
RUN echo 'server { \
    listen 3000; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html index.htm; \
        try_files $uri $uri/ /index.html; \
    } \
    location /api/ { \
        proxy_pass http://backend-api:5000; \
        proxy_set_header Host $host; \
        proxy_set_header X-Real-IP $remote_addr; \
    } \
}' > /etc/nginx/conf.d/default.conf

CMD ["nginx", "-g", "daemon off;"]
