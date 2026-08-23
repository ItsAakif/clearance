# ---- Clearance backend (Node/TS + Prisma) ----
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install deps (leverage layer cache)
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Build TypeScript
COPY . .
RUN npm run build

# Prisma client + schema available at runtime
RUN npx prisma generate || true

EXPOSE 3001
CMD ["node", "dist/index.js"]
