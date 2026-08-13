FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/action-executor/package.json ./packages/action-executor/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/shared-types/tsconfig.json ./packages/shared-types/
RUN npm install --workspace @adunni/action-executor --workspace @adunni/shared-types --ignore-scripts
COPY packages/shared-types/ ./packages/shared-types/
RUN npm run build --workspace @adunni/shared-types
COPY packages/action-executor/ ./packages/action-executor/
RUN npm run build --workspace @adunni/action-executor
EXPOSE 3004
CMD ["node", "packages/action-executor/dist/server.js"]
