# Multi-stage single-container build for MedResearch AI
# Stage 1: Build Frontend Assets
FROM node:20-alpine AS frontend-builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY index.html vite.config.ts tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production Server Runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm install -g tsx

# Copy compiled frontend SPA
COPY --from=frontend-builder /app/dist ./dist

# Copy backend source & full-stack server
COPY server.ts ./
COPY backend/ ./backend/
COPY index.html ./

EXPOSE 3000

CMD ["tsx", "server.ts"]
