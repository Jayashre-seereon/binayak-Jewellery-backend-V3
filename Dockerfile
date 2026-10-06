FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Kolkata
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
COPY . .
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node
EXPOSE 5000
# Baselines the delivered legacy database when needed, applies pending migrations, then starts the API.
CMD ["sh", "-c", "sh scripts/deploy-migrate.sh && node src/index.js"]
