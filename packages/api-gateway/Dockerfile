FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/api-gateway/package.json ./packages/api-gateway/
COPY packages/shared-types/package.json ./packages/shared-types/
RUN npm install --workspace @adunni/api-gateway --workspace @adunni/shared-types --ignore-scripts
COPY packages/shared-types/ ./packages/shared-types/
RUN npm run build --workspace @adunni/shared-types
COPY packages/api-gateway/ ./packages/api-gateway/
RUN npm run build --workspace @adunni/api-gateway
EXPOSE 3000
CMD ["node", "packages/api-gateway/dist/server.js"]
