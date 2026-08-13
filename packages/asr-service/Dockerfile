FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/asr-service/package.json ./packages/asr-service/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/shared-types/tsconfig.json ./packages/shared-types/
RUN npm install --workspace @adunni/asr-service --workspace @adunni/shared-types --ignore-scripts
COPY packages/shared-types/ ./packages/shared-types/
RUN npm run build --workspace @adunni/shared-types
COPY packages/asr-service/ ./packages/asr-service/
RUN npm run build --workspace @adunni/asr-service
EXPOSE 3001
CMD ["node", "packages/asr-service/dist/server.js"]
