FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/tts-service/package.json ./packages/tts-service/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/shared-types/tsconfig.json ./packages/shared-types/
RUN npm install --workspace @adunni/tts-service --workspace @adunni/shared-types --ignore-scripts
COPY packages/shared-types/ ./packages/shared-types/
RUN npm run build --workspace @adunni/shared-types
COPY packages/tts-service/ ./packages/tts-service/
RUN npm run build --workspace @adunni/tts-service
EXPOSE 3002
CMD ["node", "packages/tts-service/dist/server.js"]
