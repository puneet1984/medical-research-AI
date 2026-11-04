# Multi-stage production build for backend
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runner stage
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY --from=builder /usr/src/app/dist ./dist

EXPOSE 5000

CMD ["node", "dist/index.js"]
