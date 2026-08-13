FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/orchestrator/package.json ./packages/orchestrator/
COPY packages/shared-types/package.json ./packages/shared-types/
RUN npm install --workspace @adunni/orchestrator --workspace @adunni/shared-types --ignore-scripts
COPY packages/shared-types/ ./packages/shared-types/
RUN npm run build --workspace @adunni/shared-types
COPY packages/orchestrator/ ./packages/orchestrator/
RUN npm run build --workspace @adunni/orchestrator
EXPOSE 3003
CMD ["node", "packages/orchestrator/dist/server.js"]
