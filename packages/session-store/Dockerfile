FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/session-store/package.json ./packages/session-store/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/shared-types/tsconfig.json ./packages/shared-types/
COPY packages/security/package.json ./packages/security/
COPY packages/security/tsconfig.json ./packages/security/
RUN npm install --workspace @adunni/session-store --workspace @adunni/shared-types --workspace @adunni/security --ignore-scripts
COPY packages/shared-types/ ./packages/shared-types/
RUN npm run build --workspace @adunni/shared-types
COPY packages/security/ ./packages/security/
RUN npm run build --workspace @adunni/security
COPY packages/session-store/ ./packages/session-store/
RUN npm run build --workspace @adunni/session-store
EXPOSE 3006
CMD ["node", "packages/session-store/dist/server.js"]
